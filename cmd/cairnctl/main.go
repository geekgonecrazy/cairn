// cairnctl — household administration for a Cairn node.
//
// Founding a household and attesting new members are OPERATOR acts, and they
// live here rather than in the webapp for two reasons:
//
//  1. The household's 24 words never touch a browser. They are the most powerful
//     secret in the system — the root can attest any member key as anyone — and
//     the browser flow asked the inviter to type them into a form, where
//     extensions, autofill and devtools history can all reach them.
//
//  2. Founding decides what the CARRIER trusts, which is server configuration.
//     `init` writes the root to the trusted-roots file, so the chain gate is
//     strict from the first event. That removes the trust-on-first-use adoption
//     window entirely — and with it the failure where onboarding twice minted a
//     second household, adoption latched onto the first, and every event from
//     the live identity was rejected as untrusted.
//
// The private key is never written anywhere. It is derived from the words when
// needed, used, and dropped.
package main

import (
	"bufio"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/identity"
)

// stdin is a single shared scanner. A fresh bufio.Scanner per prompt buffers
// ahead and eats the line meant for the NEXT prompt — which works by accident
// on a line-buffered terminal and fails outright on piped input.
var stdin = bufio.NewScanner(os.Stdin)

func main() {
	log := func(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

	// Accept the subcommand anywhere among the flags. `cairnctl -configFile x
	// attest CODE` and `cairnctl attest -configFile x CODE` are both natural to
	// type, and rejecting the first with a bare usage dump reads like the
	// command does not exist.
	cmd, rest := splitCommand(os.Args[1:])
	if cmd == "" {
		usage()
		os.Exit(2)
	}
	args := flag.NewFlagSet(cmd, flag.ExitOnError)
	configPath := args.String("configFile", "config.yaml", "cairnd config file")

	switch cmd {
	case "init":
		name := args.String("name", "", "household name, for your own reference")
		force := args.Bool("force", false, "found again even if a root is already trusted")
		_ = args.Parse(rest)
		if err := doInit(*configPath, *name, *force); err != nil {
			log("cairnctl init: %v", err)
			os.Exit(1)
		}

	case "attest":
		phrase := args.String("phrase", "",
			"household recovery phrase, for non-interactive use (see the warning in -h)")
		passphrase := args.String("passphrase", "", "household BIP-39 passphrase, if any")
		// An agent is a member of THIS household like anyone else, not a
		// household of its own. operated_by names the human answerable for it,
		// which is what makes an agent's actions attributable to a person.
		kind := args.String("kind", "human", `"human" or "agent"`)
		operatedBy := args.String("operated-by", "",
			"for -kind agent: the human member root (64 hex) answerable for it")
		_ = args.Parse(rest)
		if err := doAttest(*configPath, args.Arg(0), *phrase, *passphrase, *kind, *operatedBy); err != nil {
			log("cairnctl attest: %v", err)
			os.Exit(1)
		}

	case "roots":
		_ = args.Parse(rest)
		if err := doRoots(*configPath); err != nil {
			log("cairnctl roots: %v", err)
			os.Exit(1)
		}

	default:
		usage()
		os.Exit(2)
	}
}

// splitCommand pulls the first bare word out of the arg list and returns it
// with everything else, so global flags may appear on either side of it.
func splitCommand(argv []string) (string, []string) {
	known := map[string]bool{"init": true, "attest": true, "roots": true}
	for i, a := range argv {
		if known[a] {
			return a, append(append([]string{}, argv[:i]...), argv[i+1:]...)
		}
	}
	return "", nil
}

func usage() {
	fmt.Fprint(os.Stderr, `cairnctl — household administration for a Cairn node

  cairnctl init [-name "The Ogles"]      found this node's household (once)
  cairnctl attest <join-code>            admit a member; prints an invite
      -phrase "word one …"               supply the phrase non-interactively
                                         (avoid where you can: it lands in shell
                                          history and the process list)
      -kind agent -operated-by <hex>     admit an AGENT under this household,
                                         answerable to that human member root.
                                         The agent keeps its own private key;
                                         it never sees the phrase.
  cairnctl roots                         list the household roots this node trusts

The household's 24 words are never stored. init shows them once; attest asks
for them each time and drops them immediately after signing.
`)
}

// rootsPath is where init records the household root. A separate file, not
// config.yaml, so writing it cannot mangle the hand-written comments there —
// and so "what this node trusts" is a small file you can read at a glance.
func rootsPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "trusted-roots.txt")
}

func loadConfig(configPath string) error {
	if err := config.Load(configPath); err != nil {
		return err
	}
	return nil
}

func doInit(configPath, name string, force bool) error {
	if err := loadConfig(configPath); err != nil {
		return err
	}
	existing := config.Config.TrustedRoots
	if len(existing) > 0 && !force {
		return fmt.Errorf(
			"this node already trusts %d household root(s):\n  %s\n\n"+
				"Founding again would mint a SECOND household. Every identity under it would be "+
				"rejected by this carrier as untrusted, which is the exact failure this command "+
				"exists to prevent. To add a member to the existing household use `cairnctl attest`; "+
				"pass -force only if you really mean to serve another household here.",
			len(existing), strings.Join(existing, "\n  "))
	}

	hh, err := identity.Bootstrap()
	if err != nil {
		return fmt.Errorf("generate household: %w", err)
	}

	fmt.Println()
	fmt.Println("════════════════════════════════════════════════════════════════")
	fmt.Println("  HOUSEHOLD RECOVERY PHRASE — write this down, on paper, now.")
	fmt.Println("════════════════════════════════════════════════════════════════")
	fmt.Println()
	for i, w := range strings.Fields(hh.Mnemonic) {
		fmt.Printf("  %2d. %-12s", i+1, w)
		if (i+1)%4 == 0 {
			fmt.Println()
		}
	}
	fmt.Println()
	fmt.Println("  This phrase IS the household. It is needed every time someone")
	fmt.Println("  joins, and it is not stored anywhere — not here, not on disk,")
	fmt.Println("  not in the app. It cannot be shown again.")
	fmt.Println()
	fmt.Println("  It is NOT your personal recovery phrase; you get one of those")
	fmt.Println("  in the app when you join as a member.")
	fmt.Println()

	if err := confirmPhrase(hh.Mnemonic); err != nil {
		return err
	}

	root := hex.EncodeToString(hh.RootPub)
	if err := appendRoot(rootsPath(configPath), root, name); err != nil {
		return err
	}

	fmt.Println()
	fmt.Printf("Household founded.\n")
	fmt.Printf("  root:        %s\n", root)
	fmt.Printf("  fingerprint: %s\n", identity.Fingerprint(hh.RootPub))
	fmt.Printf("  trusted via: %s\n", rootsPath(configPath))
	fmt.Println()
	fmt.Println("Restart cairnd to pick it up, then open the app and choose")
	fmt.Println("\"Join a household\" — including for yourself. Run:")
	fmt.Println()
	fmt.Println("  cairnctl attest <the join code the app shows you>")
	return nil
}

// confirmPhrase makes the operator prove they wrote the words down. Three
// positions, so it cannot be satisfied by copying the last line off the screen.
func confirmPhrase(mnemonic string) error {
	words := strings.Fields(mnemonic)
	// Fixed, spread-out positions rather than random: this runs in a terminal
	// where scrollback may still hold the phrase, so the check is a deliberate
	// speed bump for the honest case, not a security boundary.
	for _, idx := range []int{3, 11, len(words) - 1} {
		fmt.Printf("  Type word %d to confirm: ", idx+1)
		if !stdin.Scan() {
			return errors.New("aborted — nothing was written; run init again")
		}
		if strings.TrimSpace(strings.ToLower(stdin.Text())) != words[idx] {
			return fmt.Errorf("word %d does not match — nothing was written. "+
				"Run init again and copy the phrase carefully", idx+1)
		}
	}
	return nil
}

func appendRoot(path, root, name string) error {
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if strings.Contains(string(existing), root) {
		return nil // already trusted; nothing to do
	}
	var b strings.Builder
	if len(existing) == 0 {
		b.WriteString("# Household roots this node trusts. Written by `cairnctl init`.\n")
		b.WriteString("# One hex-encoded household root pubkey per line.\n")
		b.WriteString("#\n")
		b.WriteString("# While this file has at least one root, the chain gate is STRICT from\n")
		b.WriteString("# the first event: no trust-on-first-use adoption, so a second household\n")
		b.WriteString("# founded by accident cannot capture this node.\n")
	} else {
		b.Write(existing)
		if !strings.HasSuffix(string(existing), "\n") {
			b.WriteString("\n")
		}
	}
	if name != "" {
		fmt.Fprintf(&b, "%s  # %s\n", root, name)
	} else {
		fmt.Fprintf(&b, "%s\n", root)
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func doAttest(configPath, joinCode, phraseFlag, passFlag, kindFlag, operatedByHex string) error {
	if err := loadConfig(configPath); err != nil {
		return err
	}
	if strings.TrimSpace(joinCode) == "" {
		return errors.New("pass the join code the newcomer's app is showing:\n" +
			"  cairnctl attest cairn:join:1:...")
	}
	req, err := identity.ParseJoinRequest(joinCode)
	if err != nil {
		return err
	}

	kind := identity.KindHuman
	var operatedBy []byte
	if kindFlag == "agent" {
		kind = identity.KindAgent
		operatedBy, err = hex.DecodeString(operatedByHex)
		if err != nil || len(operatedBy) != ed25519.PublicKeySize {
			return errors.New("-kind agent requires -operated-by <64 hex>: the human member " +
				"root answerable for this agent. An agent nobody operates is an agent nobody " +
				"is accountable for")
		}
	} else if kindFlag != "human" {
		return fmt.Errorf("-kind must be \"human\" or \"agent\", got %q", kindFlag)
	} else if operatedByHex != "" {
		return errors.New("-operated-by only applies to -kind agent")
	}

	fmt.Printf("\nThis code asks to join as %q.\n", req.DisplayName)
	fmt.Printf("  member key:  %s\n", hex.EncodeToString(req.MemberPub))
	fmt.Printf("  fingerprint: %s\n", identity.Fingerprint(req.MemberPub))
	fmt.Println()
	fmt.Println("The name is SELF-DECLARED — anyone can claim any name. Only approve")
	fmt.Println("this if you were expecting it from them, and check the fingerprint")
	fmt.Println("against what their screen shows.")
	fmt.Println()

	// -phrase exists because there is not always a terminal to prompt at: CI,
	// scripts, and any harness that runs commands with stdin closed, where the
	// prompt gets EOF and the whole thing aborts on the first keystroke it never
	// receives. It is NOT the preferred path — a phrase on a command line lands
	// in shell history and is visible in the process list — so the help says so
	// and the interactive prompt stays the default.
	mnemonic, passphrase := phraseFlag, passFlag
	if mnemonic == "" {
		var err error
		mnemonic, err = readPhrase("Household recovery phrase (24 words): ")
		if err != nil {
			return fmt.Errorf("%w\n\nNo terminal to read from? Pass the phrase instead:\n"+
				"  cairnctl attest -phrase \"word one word two …\" <join-code>", err)
		}
		passphrase, err = readPhrase("Passphrase (blank if none): ")
		if err != nil {
			return err
		}
	}

	att, err := identity.ProvisionMember(
		mnemonic, passphrase, req.MemberPub, kind, req.DisplayName, operatedBy, time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("sign attestation: %w", err)
	}

	// A wrong phrase does not error — BIP-39 has no wrong answers, it just
	// derives a different household. Catch that here rather than handing over an
	// invite that nobody on this node will accept.
	origin := hex.EncodeToString(att.Origin)
	if !trusted(origin) {
		return fmt.Errorf(
			"those words derive household %s, which this node does not trust.\n"+
				"A wrong phrase or passphrase does not fail — it silently produces a DIFFERENT "+
				"household. Check both, or run `cairnctl roots` to see what is trusted here",
			identity.Fingerprint(att.Origin))
	}

	blob, err := identity.EncodeInvite(att)
	if err != nil {
		return err
	}
	fmt.Println()
	fmt.Println("Invite — send this back to them:")
	fmt.Println()
	fmt.Println(blob)
	fmt.Println()
	fmt.Printf("They should see household fingerprint %s when they paste it.\n",
		identity.Fingerprint(att.Origin))
	return nil
}

func trusted(originHex string) bool {
	for _, r := range config.Config.TrustedRoots {
		if strings.EqualFold(strings.TrimSpace(r), originHex) {
			return true
		}
	}
	return false
}

func doRoots(configPath string) error {
	if err := loadConfig(configPath); err != nil {
		return err
	}
	roots := config.Config.TrustedRoots
	if len(roots) == 0 {
		fmt.Println("This node trusts no household root yet — run `cairnctl init`.")
		fmt.Println()
		fmt.Println("Until then the carrier refuses every event: an empty trust list is")
		fmt.Println("default-deny, not open.")
		return nil
	}
	fmt.Printf("This node trusts %d household root(s):\n\n", len(roots))
	for _, r := range roots {
		b, err := hex.DecodeString(strings.TrimSpace(r))
		if err != nil || len(b) != 32 {
			fmt.Printf("  %s   (MALFORMED — not a 32-byte hex pubkey)\n", r)
			continue
		}
		fmt.Printf("  %s\n    fingerprint %s\n", r, identity.Fingerprint(b))
	}
	return nil
}

// readPhrase reads a line from stdin. Deliberately echoed: the operator is
// typing 24 words they are reading off paper, and hiding them makes typos
// undetectable — the failure mode is a silently different household, which is
// worse than the shoulder-surfing risk in a room you already control.
func readPhrase(prompt string) (string, error) {
	fmt.Print(prompt)
	if !stdin.Scan() {
		// EOF before an answer. For the passphrase that is almost always "I have
		// no passphrase and piped only the phrase", so treat it as blank rather
		// than failing a flow that was one keystroke from done.
		if strings.HasPrefix(prompt, "Passphrase") {
			fmt.Println()
			return "", nil
		}
		return "", errors.New("aborted")
	}
	return strings.TrimSpace(stdin.Text()), nil
}
