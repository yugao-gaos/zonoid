import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from './relay.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

function loadPolicy() {
  const candidates = [
    process.env.ZONOID_ROOT && path.join(process.env.ZONOID_ROOT, 'hooks', 'lib', 'gate-policy.js'),
    path.resolve(here, '../../../hooks/lib/gate-policy.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Try the installed-root fallback.
    }
  }
  return null
}

const policy = loadPolicy()
const DIRECT_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch', 'str_replace_editor'])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_send'])

function directTargets(name, args) {
  const toolInput = { ...(args || {}) }
  if (toolInput.file_path == null) {
    toolInput.file_path = toolInput.filePath ?? toolInput.path ?? toolInput.file ?? ''
  }
  return policy.writeEditTargets({ tool_name: name, tool_input: toolInput })
}

export function mutationForExecution(exec, workspace, port = 8787) {
  if (!policy) return DIRECT_WRITE_TOOLS.has(exec?.name) || SHELL_TOOLS.has(exec?.name)
    ? { targets: [], policyMissing: true }
    : null

  const name = String(exec?.name || '').toLowerCase()
  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
  if (DIRECT_WRITE_TOOLS.has(name)) {
    if (name === 'str_replace_editor' && String(args.command || '').toLowerCase() === 'view') return null
    return { targets: directTargets(name, args) }
  }
  if (!SHELL_TOOLS.has(name)) return null

  const command = String(args.command ?? args.input ?? args.text ?? args.chars ?? '')
  if (!command || policy.isGitCommandExempt(command) || policy.isLocalDaemonCommand(command, port)) return null
  if (!policy.hasBashWritePattern(command)) return null
  return { targets: policy.bashWriteTargets(command, args.workdir || args.cwd || workspace) }
}

function claimGit(detail) {
  const git = detail?.task?.git
  if (!git?.branch || !git?.worktree) return null
  return { branch: String(git.branch), worktree: String(git.worktree) }
}

async function permitForClaim(relay, { sessionId, agentId, workspace, taskKey, signal }) {
  const response = await relay.get(query('/subconscious/permit', {
    session_id: sessionId,
    agent_id: agentId,
    workspace,
    task_key: taskKey,
  }), signal, 600)
  return response?.execution_permit || response?.permit || null
}

export async function gateExecution(exec, options = {}) {
  const port = Number(options.port || process.env.ORCH_PORT || 8787)
  const mutation = mutationForExecution(exec, options.workspace, port)
  if (!mutation) return { allow: true }
  if (process.env.ORCH_GATE_OFF === '1') return { allow: true }
  if (!policy || mutation.policyMissing) {
    return { allow: false, reason: 'orch-gate: shared gate policy is unavailable' }
  }
  if (policy.allTargetsExempt(mutation.targets)) return { allow: true }

  const sessionId = String(options.sessionId || '').trim()
  if (!sessionId) return { allow: true }
  const relay = options.relay
  const claim = await relay.get(query('/active-claim', { session: sessionId, workspace: options.workspace }), options.signal, 600)
  if (!claim) return { allow: true } // daemon unreachable: preserve the adapter fail-open contract
  if (claim.claimed !== true) {
    return { allow: false, reason: 'orch-gate: accept a prepared Subconscious assignment before writing' }
  }
  if (!mutation.targets.length) {
    return { allow: false, reason: 'orch-gate: the write target is not concrete enough to verify against the assigned worktree' }
  }

  let lastReason = 'no matching Subconscious execution permit found'
  for (const item of Array.isArray(claim.claims) ? claim.claims : []) {
    if (!item?.key) continue
    const claimAgentId = String(item.agent_id || '').trim()
    if (!claimAgentId) {
      lastReason = 'claimed assignment is missing an authoritative agent identity'
      continue
    }
    const detail = await relay.get(query('/task/detail', { key: item.key, workspace: item.workspace || options.workspace }), options.signal, 600)
    const git = claimGit(detail)
    if (!git) {
      lastReason = 'claimed assignment is missing a registered worktree'
      continue
    }
    const outside = policy.firstOutsideWorktree(mutation.targets, git.worktree)
    if (outside) {
      lastReason = `write target is outside the assigned worktree (${outside})`
      continue
    }
    const permit = await permitForClaim(relay, {
      sessionId,
      agentId: claimAgentId,
      workspace: item.workspace || options.workspace,
      taskKey: item.key,
      signal: options.signal,
    })
    const validation = policy.validateExecutionPermit(permit, {
      sessionId,
      taskKey: item.key,
      branch: git.branch,
      worktree: git.worktree,
      agentId: claimAgentId,
    })
    if (!validation.ok) {
      lastReason = validation.reason
      continue
    }
    const outsidePermit = policy.firstOutsidePermitScope(mutation.targets, git.worktree, permit)
    if (outsidePermit) {
      lastReason = `write target is outside the execution permit (${outsidePermit})`
      continue
    }
    return { allow: true }
  }

  return { allow: false, reason: `orch-gate: ${lastReason}` }
}
