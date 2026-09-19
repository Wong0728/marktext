// Cross-cutting main-process runtime flags that a few unrelated modules need
// to agree on. Kept tiny and dependency-free so both the app controller and
// the window classes can import it without a cycle.

// Set once the OS tells us the session is ending (shutdown / logout). During
// an OS-initiated session end the system will not wait for our per-window
// "save your changes?" handshake, and blocking it with `preventDefault` can
// stall the whole shutdown. When this is set, editor windows close directly;
// any unsaved content is still preserved by the crash-recovery snapshot and
// offered again on the next launch.
let sessionEnding = false

export const isSessionEnding = (): boolean => sessionEnding

export const markSessionEnding = (): void => {
  sessionEnding = true
}
