"""
Claude Code agent implementation.
"""

import json
import shlex
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from featurebench.infer.agents.base import BaseAgent
from featurebench.infer.container import DOCKER_HOST_GATEWAY


class ClaudeCodeAgent(BaseAgent):
    """Claude Code agent for FeatureBench inference."""

    # Allowed tools for Claude Code
    ALLOWED_TOOLS = [
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Glob",
        "Grep",
        "LS",
        "WebFetch",
        "NotebookEdit",
        "NotebookRead",
        "TodoRead",
        "TodoWrite",
        "Agent",
    ]

    @property
    def name(self) -> str:
        return "claude_code"

    @property
    def install_script(self) -> str:
        """Installation script for Claude Code."""
        version = self._kwargs.get("version") or self.env_vars.get("CLAUDE_CODE_VERSION") or "latest"

        return f"""#!/bin/bash
set -e

echo "Installing Claude Code agent..."

# Update package manager
apt-get update
apt-get install -y curl ca-certificates tar xz-utils

CACHE_ROOT="${{AGENT_DOWNLOAD_CACHE:-/download}}"
mkdir -p "$CACHE_ROOT" "$CACHE_ROOT/npm"

export npm_config_cache="$CACHE_ROOT/npm"
export NPM_CONFIG_CACHE="$CACHE_ROOT/npm"

NVM_DIR="/opt/featurebench/nvm"
mkdir -p "$NVM_DIR"

# NOTE: Do NOT share NVM's download cache across containers.
# FeatureBench often runs many infer containers concurrently; sharing the tarball
# cache can lead to corrupted archives and checksum/tar extraction failures.
mkdir -p "$NVM_DIR/.cache"

NODE_VERSION="22"

# Install NVM (idempotent)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | env NVM_DIR="$NVM_DIR" bash

export NVM_DIR
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ -z "$(command -v nvm)" ]; then
    echo "nvm not available after install" >&2
    exit 1
fi

# Install or reuse Node
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

# Verify npm
npm -v

# Install Claude Code (downloads cached via NPM_CONFIG_CACHE)
npm install -g @anthropic-ai/claude-code@{version}

# Verify installation
claude --version || echo "Claude Code installed"

echo "Claude Code installation complete"
"""

    def get_run_command(self, instruction: str) -> str:
        """Get the command to run Claude Code."""
        full_instruction = instruction.rstrip()

        escaped_instruction = shlex.quote(full_instruction)
        allowed_tools = " ".join(self.ALLOWED_TOOLS)

        return (
            f"NVM_DIR=${{NVM_DIR:-/opt/featurebench/nvm}}; "
            f"[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" || true; "
            f"claude --verbose "
            f"-p \"$(cat /tmp/fb_instruction.txt)\" --allowedTools {allowed_tools} "
            f"--output-format stream-json | tee /agent-logs/claude_code_stream_output.jsonl"
        )

    # ── Zonoid helpers ────────────────────────────────────────────────────────

    def _zonoid_get(self, host_url: str, path: str):
        """GET request to zonoid daemon, returns parsed JSON or None."""
        try:
            req = urllib.request.Request(f"{host_url}{path}")
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            self.logger.warning(f"zonoid GET {path}: {e}")
            return None

    def _zonoid_post(self, host_url: str, path: str, body: dict):
        """POST request to zonoid daemon, returns parsed JSON or None."""
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(
                f"{host_url}{path}", data=data,
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            self.logger.warning(f"zonoid POST {path}: {e}")
            return None

    def _setup_zonoid_context(self, host_url: str, instance_id: str, task_summary: str) -> dict:
        """
        Register the FB task as a note node, then use semantic search to find the most
        relevant KB notes for this task. Returns dict with note_key and search_results.
        """
        # 1. Register FB task as a note (for provenance + future suggest_links)
        self.logger.info(f"Registering task {instance_id} in zonoid graph...")
        note_resp = self._zonoid_post(host_url, "/overlay/note", {
            "title": f"FB task: {instance_id}",
            "summary": task_summary,
            "category": "featurebench",
            "tags": [instance_id.split(".")[0], "featurebench"],
        })
        note_key = (note_resp or {}).get("key")
        self.logger.info(f"  Note key: {note_key}")

        # Give embedder time to index the new note
        time.sleep(2)

        # 2. Semantic search for relevant KB notes
        self.logger.info("Searching KB for relevant context...")
        qs = urllib.parse.urlencode({"q": task_summary})
        search_resp = self._zonoid_get(host_url, f"/search?{qs}")
        results = []
        if search_resp and isinstance(search_resp.get("results"), list):
            for r in search_resp["results"][:6]:
                label = r.get("label", "")
                summary = r.get("summary", "")
                score = r.get("score", 0)
                if summary and score > 0.1:
                    results.append({"label": label, "summary": summary, "score": score})
                    display = label or summary[:60]
                    self.logger.info(f"  [{score:.3f}] {display[:80]}")

        # 3. Also run suggest_links on the note (for DAG wiring)
        if note_key:
            qs2 = urllib.parse.urlencode({"key": note_key})
            suggest_resp = self._zonoid_get(host_url, f"/task/suggest?{qs2}")
            suggestions = (suggest_resp or {}).get("suggestions", [])
            for s in suggestions[:5]:
                node_key = s.get("key")
                score = s.get("ceScore") or s.get("score") or 0
                if node_key and score > 0.2 and not s.get("duplicate"):
                    self._zonoid_post(host_url, "/overlay/edge", {
                        "from": note_key, "to": node_key, "kind": "context"
                    })
                    self.logger.info(f"  Wired edge: {node_key} ({score:.3f})")

        return {"note_key": note_key, "context_deps": results}

    def _build_agents_md(self, instance_id: str, agent_url: str, context_deps: list, note_key: Optional[str] = None) -> str:
        """Build /testbed/AGENTS.md: pre-fetched context + live search instructions."""
        lines = [
            "# Zonoid Knowledge Base",
            "",
            f"A live Zonoid KB instance is accessible at **{agent_url}** with pre-built",
            "knowledge about this repository.",
            "",
            f"**Your task ID**: `{instance_id}`",
            "",
        ]

        # Pre-wired context bullets
        if context_deps:
            lines += ["## Pre-loaded context (verified for this task)", ""]
            for dep in context_deps:
                summary = dep.get("summary", "")
                label = dep.get("label", "").strip()
                if not summary:
                    continue
                # Notes store content in summary; use first sentence as a heading if no label
                if label:
                    lines.append(f"- **{label}**: {summary}")
                else:
                    lines.append(f"- {summary}")
            lines.append("")

        lines += [
            "## Instructions",
            "",
            "**Before writing any code**, complete these steps:",
            "",
            "### 1. Check your pre-loaded context above — it contains repo-specific KB.",
            "",
            "### 2. Search for relevant knowledge as you work:",
            "```bash",
            f'curl -s "{agent_url}/search?q=YOUR+QUERY+HERE"',
            "```",
            "",
            "### 3. Record discoveries for future tasks:",
            "```bash",
            f"curl -s -X POST {agent_url}/overlay/note \\",
            "  -H 'Content-Type: application/json' \\",
            f"""  -d '{{"title":"FB finding: {instance_id}","summary":"What you discovered","tags":["featurebench","{instance_id}"]}}'""",
            "```",
            "",
        ]
        if note_key:
            lines += [
                "### 4. Link useful discoveries back to this benchmark note:",
                "```bash",
                f"curl -s -X POST {agent_url}/overlay/edge \\",
                "  -H 'Content-Type: application/json' \\",
                f"""  -d '{{"from":"note:NEW_NOTE_ID","to":"{note_key}","kind":"context"}}'""",
                "```",
                "",
            ]
        return "\n".join(lines)

    # ── Lifecycle hooks ───────────────────────────────────────────────────────

    def pre_run_hook(self, container, log_file) -> bool:
        """
        1. Create /agent-logs.
        2. If ZONOID_URL is set: register task in host zonoid, wire KB context via
           suggest_links, fetch dependency summaries, write smart AGENTS.md pointing
           at host gateway so the agent can call zonoid live during the session.
        3. Fallback (ZONOID_URL not set, FB_KB_PATH set): static KB file injection.
        """
        self.cm.exec_command(container, "mkdir -p /agent-logs", log_file=log_file)

        zonoid_url = self.env_vars.get("ZONOID_URL")

        if zonoid_url:
            # --- Zonoid-native path ---
            # instance_id lives two levels above the attempt log:
            #   .../run_outputs/<instance_id>/attempt-N/infer.log
            instance_id = Path(log_file).parent.parent.name
            agent_url = f"http://{DOCKER_HOST_GATEWAY}:{urllib.parse.urlparse(zonoid_url).port or 8787}"

            # Task summary seeded from the instance_id tokens for embedding quality
            parts = instance_id.split(".")
            task_summary = (
                f"FeatureBench task: implement feature '{parts[2]}' in {parts[0]} (difficulty {parts[-1]})"
                if len(parts) >= 4 else f"FeatureBench task: {instance_id}"
            )

            ctx = self._setup_zonoid_context(zonoid_url, instance_id, task_summary)

            agents_md = self._build_agents_md(instance_id, agent_url, ctx["context_deps"], ctx["note_key"])

            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".md", delete=False, encoding="utf-8", newline="\n"
            ) as f:
                f.write(agents_md)
                md_path = Path(f.name)
            try:
                self.cm.copy_to_container(container, md_path, "/testbed/AGENTS.md")
                self.logger.info(
                    f"Injected zonoid AGENTS.md for {instance_id} "
                    f"(note={ctx['note_key']}, {len(ctx['context_deps'])} context deps, "
                    f"{len(agents_md)} chars)"
                )
            finally:
                md_path.unlink(missing_ok=True)

        else:
            # --- Legacy static KB fallback ---
            kb_path = self.env_vars.get("FB_KB_PATH")
            if kb_path:
                src = Path(kb_path)
                if src.is_file():
                    self.cm.copy_to_container(container, src, "/testbed/AGENTS.md")
                    self.logger.info(f"Injected static KB into /testbed/AGENTS.md (from {kb_path})")
                else:
                    self.logger.warning(f"FB_KB_PATH set but file not found: {kb_path}")

        return True

    def prepare_run(self, container, instruction, log_file) -> bool:
        """Write the (large) instruction to a container file so get_run_command reads it via
        $(cat /tmp/fb_instruction.txt). Embedding it on the docker-exec command line overflows
        the Windows 32767-char CreateProcess limit (WinError 206); FeatureBench instructions are
        far longer. copy_to_container uses tar/put_archive, so there's no command-line length cap."""
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8', newline='\n')
        try:
            tmp.write(instruction)
            tmp.close()
            self.cm.copy_to_container(container, Path(tmp.name), "/tmp/fb_instruction.txt")
            self.logger.info(f"Wrote instruction ({len(instruction)} chars) to /tmp/fb_instruction.txt")
        finally:
            try:
                Path(tmp.name).unlink()
            except Exception:
                pass
        return True

    def post_run_hook(self, container, log_file) -> bool:
        """
        Save claude_code_stream_output.jsonl
        Check if the last line of claude_code_stream_output.jsonl is a success
        If not, return False
        If success, return True
        """
        log_dir = Path(log_file).parent

        claude_code_stream_output_copied = self.cm.copy_from_container(
            container,
            "/agent-logs/claude_code_stream_output.jsonl",
            log_dir / "claude_code_stream_output.jsonl"
        )

        if not claude_code_stream_output_copied:
            self.logger.error("Failed to copy claude_code_stream_output.jsonl from container")
            return False

        stream_path = log_dir / "claude_code_stream_output.jsonl"
        with open(stream_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        last_line_json = json.loads(lines[-1])

        # Count live KB search calls (curl to zonoid endpoint)
        kb_calls = sum(
            1 for line in lines
            if f":{urllib.parse.urlparse(self.env_vars.get('ZONOID_URL', '')).port or 8787}/search" in line
        )
        if kb_calls:
            self.logger.info(f"Agent made {kb_calls} live KB search call(s) to zonoid")
        else:
            self.logger.info("Agent made 0 live KB search calls (used pre-loaded context only)")

        is_result_success = (
            last_line_json.get("type") == "result" and last_line_json.get("subtype") == "success"
        )
        if not is_result_success:
            self.logger.error(
                "Last line of claude_code_stream_output.jsonl is not result/success; agent may not have finished properly"
            )
            return False

        if "is_error" not in last_line_json:
            self.logger.error(
                "claude_code_stream_output.jsonl last result is missing is_error; treating as failure"
            )
            return False

        is_error = last_line_json.get("is_error")
        if is_error is False:
            return True

        if is_error is True:
            result = last_line_json.get("result")
            if isinstance(result, str):
                result_preview = result.replace("\n", " ")[:300]
            else:
                result_preview = str(result)[:300]
            self.logger.error(
                "Claude Code reported is_error=true; treating as failure. "
                f"Result preview: {result_preview}"
            )
            return False

        self.logger.error(f"Claude Code reported unexpected is_error={is_error!r}; treating as failure")
        return False

    def failure_hook(self, container, log_file) -> None:
        log_dir = Path(log_file).parent
        try:
            self.cm.copy_from_container(
                container,
                "/agent-logs/claude_code_stream_output.jsonl",
                log_dir / "claude_code_stream_output.jsonl",
            )
        except Exception:
            pass

    def get_env_setup_script(self) -> str:
        """Get environment setup script for Claude Code."""
        lines = ["#!/bin/bash", ""]

        required_vars = {
            "ANTHROPIC_API_KEY": self.env_vars.get("ANTHROPIC_API_KEY", ""),
            "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "ENABLE_BACKGROUND_TASKS": "1",
            "DISABLE_TELEMETRY": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }

        model = self._kwargs.get("model")
        if model:
            if "/" in model:
                model = model.split("/")[-1]
            required_vars["ANTHROPIC_MODEL"] = model
            required_vars["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = model
            required_vars["ANTHROPIC_DEFAULT_SONNET_MODEL"] = model
            required_vars["ANTHROPIC_DEFAULT_OPUS_MODEL"] = model

        for key, value in self.env_vars.items():
            if key not in required_vars and value:
                required_vars[key] = value

        for key, value in required_vars.items():
            if value:
                value_str = str(value)
                if 'localhost' in value_str or '127.0.0.1' in value_str:
                    value_str = value_str.replace('localhost', DOCKER_HOST_GATEWAY)
                    value_str = value_str.replace('127.0.0.1', DOCKER_HOST_GATEWAY)
                escaped_value = value_str.replace("'", "'\\''")
                lines.append(f"export {key}='{escaped_value}'")

        lines.extend(self._get_proxy_unset_lines())

        lines.extend([
            "",
            "# Load NVM",
            'export NVM_DIR="/opt/featurebench/nvm"',
            '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
        ])

        return "\n".join(lines)
