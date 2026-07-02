"""Planner for the ARC-AGI-3 EWM agent (Pillar 4).

Two search modes over a ``WorldModelProgram``:

* ``plan`` — breadth-first search from the start frame toward a goal predicate, returning the
  shortest action sequence plus the per-action predicted grids (consumed at execute time for
  divergence-abort).
* ``rollout_search`` — a seeded random-rollout fallback for cases without a clean goal predicate;
  returns the best-scoring action prefix and its predicted grids. Deterministic given a seed.
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .world_model import Action, Grid, WorldModelProgram


@dataclass
class PlanResult:
    """A found plan: the actions to apply and the grid predicted after each action."""

    actions: list[Action] = field(default_factory=list)
    predicted_grids: list[Grid] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.actions)


def _grid_key(grid: Grid) -> tuple:
    """Hashable canonical form of a rendered grid (for BFS visited-set dedup)."""

    return tuple(tuple(row) for row in grid)


def plan(
    program: WorldModelProgram,
    start_frame: Grid,
    goal_fn: Callable[[Any], bool],
    max_depth: int = 40,
    max_nodes: int = 20000,
    actions: list[Action] | None = None,
) -> PlanResult | None:
    """BFS from ``start_frame`` toward ``goal_fn(state)``.

    States are deduplicated by their rendered-grid key. At each node the action set comes from
    ``actions`` when provided, else ``program.legal_actions(state)``. Returns the shortest plan
    (``PlanResult``) or ``None`` if no goal state is reachable within the depth/node budget.
    """

    start_state = program.init_state(start_frame)
    if goal_fn(start_state):
        return PlanResult(actions=[], predicted_grids=[])

    start_key = _grid_key(program.render(start_state))
    visited: set[tuple] = {start_key}

    # Queue items: (state, actions_so_far, predicted_grids_so_far)
    queue: deque[tuple[Any, list[Action], list[Grid]]] = deque()
    queue.append((start_state, [], []))
    expanded = 0

    while queue:
        state, path, grids = queue.popleft()
        if len(path) >= max_depth:
            continue
        expanded += 1
        if expanded > max_nodes:
            return None

        candidate_actions = actions if actions is not None else program.legal_actions(state)
        for action in candidate_actions:
            next_state, _events = program.step(state, action)
            next_grid = program.render(next_state)
            key = _grid_key(next_grid)
            if key in visited:
                continue

            new_path = path + [action]
            new_grids = grids + [next_grid]

            if goal_fn(next_state):
                return PlanResult(actions=new_path, predicted_grids=new_grids)

            visited.add(key)
            queue.append((next_state, new_path, new_grids))

    return None


def rollout_search(
    program: WorldModelProgram,
    start_frame: Grid,
    score_fn: Callable[[Any], float],
    n_rollouts: int,
    max_depth: int,
    seed: int,
) -> PlanResult:
    """Seeded random-rollout fallback when there is no clean goal predicate.

    Runs ``n_rollouts`` random walks of up to ``max_depth`` steps from ``start_frame``, scoring
    each visited state with ``score_fn``. Returns the action prefix (and predicted grids) leading
    to the single best-scoring state seen across all rollouts. Fully deterministic given ``seed``.
    """

    rng = random.Random(seed)
    start_state = program.init_state(start_frame)

    best_score = score_fn(start_state)
    best = PlanResult(actions=[], predicted_grids=[])

    for _ in range(n_rollouts):
        state = start_state
        path: list[Action] = []
        grids: list[Grid] = []

        for _ in range(max_depth):
            candidate_actions = program.legal_actions(state)
            if not candidate_actions:
                break
            action = rng.choice(candidate_actions)
            state, _events = program.step(state, action)
            path = path + [action]
            grids = grids + [program.render(state)]

            score = score_fn(state)
            if score > best_score:
                best_score = score
                best = PlanResult(actions=list(path), predicted_grids=list(grids))

    return best
