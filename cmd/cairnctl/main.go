// cairnctl — Cairn node administration.
//
// The household-founding and attestation commands (init / attest / roots) were
// removed with the v2 trust model: there is no household root to found, and a
// member identity is a self-sovereign key that self-attests, so nobody needs to
// vouch for a newcomer via a CLI (docs/decisions.md §Trust model v2).
//
// This binary is kept as the home for RELAY administration — issuing invite
// tokens and managing the allow-list — which lands in a later slice. For now it
// has no subcommands.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr,
		"cairnctl: no commands yet.\n\n"+
			"Household founding (init/attest/roots) was removed with the v2 trust model:\n"+
			"identity is a self-sovereign key that self-attests — there is nothing to found.\n"+
			"Relay administration (invite tokens, allow-list) will live here in a later slice.")
	os.Exit(2)
}
