package identity

import "strings"

// splitWords splits a mnemonic on any run of whitespace, ignoring leading and
// trailing space. Humans retyping a recovery phrase produce double spaces and
// stray newlines; those are not errors.
func splitWords(s string) []string { return strings.Fields(s) }

// normalizeMnemonic canonicalizes a human-typed phrase into the exact form
// BIP-39 checksums: lowercase words separated by single spaces. Case and
// whitespace are the two things people reliably get wrong when copying 24 words
// off paper, and neither should change the derived household.
//
// NOTE: this deliberately does NOT correct spelling. A misspelled word fails
// the checksum in ValidateMnemonic, which is the honest outcome — silently
// snapping to the nearest wordlist entry could hand someone a valid-looking
// phrase for a household that is not theirs.
func normalizeMnemonic(s string) string {
	words := splitWords(s)
	for i, w := range words {
		words[i] = strings.ToLower(w)
	}
	return strings.Join(words, " ")
}
