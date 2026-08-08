# App engineering follow-ups

Implementation work retained after the 8 August 2026 founder-ledger audit.
These are agent-owned backlog items, not founder/operator gates.

## Open

1. **Evaluate optional Programs hierarchy.** Planning periods now provide the
   shipped time hierarchy. Add a separate advanced Programs level only if a
   real workflow remains unserved; do not add hierarchy for its own sake.
2. **Finish the custom icon workflow.** Replace remaining generic assets only
   as approved custom icons become available, preserving accessible labels.
3. **Connect the board Nudge surface.** The persistence, permissions,
   recipient resolution, preference, audit, and delivery backend exists. Wire
   the remaining board dialog to the existing server action with deterministic
   tests. Do not trigger a live notification or email during implementation.
4. **Add attachment thumbnails.** Define multiple-image, non-image,
   replacement, removal, loading, permission, and failed-preview behaviour on
   top of the shipped Vercel Blob storage seam.
5. **Add task tag editing.** Tag actions exist server-side; complete the task
   detail and board editing path with workspace-scoped permission coverage.

## Closed by shipped evidence

- Custom columns, waiting-lane migration, the canonical done predicate, and
  narrow money roll-up shipped as T121, T122, and T124.
- The board Filter now covers priority, column, owner by name, and date (T125).
- The multi-repo `log-cycle` ritual and the standalone Timeline repository were
  retired by the consolidated data-layer reset.
