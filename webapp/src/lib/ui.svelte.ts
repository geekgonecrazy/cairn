// Ephemeral view state — nothing here is protocol, persisted, or synced.
// Kept out of AppState so the DAG/crypto state stays free of chrome concerns.

class UIState {
  /** Mobile nav drawer. Ignored above the 900px breakpoint, where the rail
   *  and room list are always-visible grid columns. */
  navOpen = $state(false)

  openNav() {
    this.navOpen = true
  }

  closeNav() {
    this.navOpen = false
  }

  toggleNav() {
    this.navOpen = !this.navOpen
  }

  /** Identity & devices panel. Opened from the rail's avatar (`.me`), per the
   *  design: identity is YOU-scoped, so it belongs on the rail — not in the room
   *  header, which is room-scoped (call / members / room settings). */
  identityOpen = $state(false)

  openIdentity() {
    this.identityOpen = true
    this.navOpen = false // the drawer would cover the panel on mobile
  }

  closeIdentity() {
    this.identityOpen = false
  }
}

export const ui = new UIState()
