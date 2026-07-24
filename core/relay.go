package core

import "github.com/geekgonecrazy/cairn/config"

// RelayRequiresInvite reports whether this relay gates the write path on its
// allow-list (invite-only). The client fetches this via RelayInfo so it can
// require an invite during onboarding, instead of letting the user finish and
// then hit a wall of send failures.
func RelayRequiresInvite() bool { return config.Config.RequireInvite }

// Relay directory (slice 3). The directory is the relay's allow-listed members
// that have published a self-attestation, with their self-asserted profile. It
// backs add-by-name in the client and is the "relay-vouched" name tier: the
// operator admitted these keys, so their names are as trustworthy as that
// curation — not a cryptographic guarantee (docs/adrs/0015-relay-directory-edge-trust.md).
// A name here is still a label; the pubkey is the identity.

// DirectoryEntry is one member of the relay's directory.
type DirectoryEntry struct {
	MemberPub   []byte
	DisplayName string
	Kind        string
}

// Directory returns the allow-listed members that have a stored self-attestation.
// A member who is admitted but has not published a profile yet is skipped — you
// can still add them by key, they just aren't browsable by name.
func Directory() ([]DirectoryEntry, error) {
	allowed, err := st.ListAllowed()
	if err != nil {
		return nil, err
	}
	out := make([]DirectoryEntry, 0, len(allowed))
	for _, m := range allowed {
		att, ok := st.Attestation(m.MemberPub)
		if !ok {
			continue
		}
		out = append(out, DirectoryEntry{
			MemberPub:   append([]byte(nil), att.Pubkey...),
			DisplayName: att.DisplayName,
			Kind:        string(att.Kind),
		})
	}
	return out, nil
}
