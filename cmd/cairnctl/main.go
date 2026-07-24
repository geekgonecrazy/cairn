// cairnctl — Cairn relay administration.
//
// v2 trust model: there is no household to found. This tool manages the relay's
// OPERATIONAL admission (docs/adrs/0014-relay-operational-admission.md) — issuing invite
// tokens and editing the allow-list of member roots the relay will carry. It is
// NOT identity trust, which stays per-key at the edge. cairnctl opens the same
// store cairnd uses.
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/identity"
	"github.com/geekgonecrazy/cairn/relay"
	"github.com/geekgonecrazy/cairn/store"
	"github.com/geekgonecrazy/cairn/store/sqlite"
)

func main() {
	logf := func(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

	cmd, rest := splitCommand(os.Args[1:])
	if cmd == "" {
		usage()
		os.Exit(2)
	}
	args := flag.NewFlagSet(cmd, flag.ExitOnError)
	configPath := args.String("configFile", "config.yaml", "cairnd config file")

	switch cmd {
	case "invite":
		days := args.Int("expires", 0, "days until the invite expires (0 = never)")
		_ = args.Parse(rest)
		if err := doInvite(*configPath, *days); err != nil {
			logf("cairnctl invite: %v", err)
			os.Exit(1)
		}
	case "allow":
		_ = args.Parse(rest)
		if err := doAllow(*configPath, args.Arg(0)); err != nil {
			logf("cairnctl allow: %v", err)
			os.Exit(1)
		}
	case "disallow":
		_ = args.Parse(rest)
		if err := doDisallow(*configPath, args.Arg(0)); err != nil {
			logf("cairnctl disallow: %v", err)
			os.Exit(1)
		}
	case "allowlist":
		_ = args.Parse(rest)
		if err := doAllowlist(*configPath); err != nil {
			logf("cairnctl allowlist: %v", err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(2)
	}
}

// splitCommand pulls the first known subcommand out of the args so global flags
// may appear on either side of it.
func splitCommand(argv []string) (string, []string) {
	known := map[string]bool{"invite": true, "allow": true, "disallow": true, "allowlist": true}
	for i, a := range argv {
		if known[a] {
			return a, append(append([]string{}, argv[:i]...), argv[i+1:]...)
		}
	}
	return "", nil
}

func usage() {
	fmt.Fprint(os.Stderr, `cairnctl — Cairn relay administration

  cairnctl invite [-expires DAYS]     mint a single-use invite token
  cairnctl allow <member-hex>         admit a member root directly
  cairnctl disallow <member-hex>      remove a member root from the allow-list
  cairnctl allowlist                  list the member roots this relay carries

The allow-list is OPERATIONAL admission (who may use this relay), NOT identity
trust. When requireInvite is off (the dev default) the relay admits any valid
sender trust-on-first-use; turn it on to require an invite or an explicit allow.
`)
}

func openStore(configPath string) (store.Store, error) {
	if err := config.Load(configPath); err != nil {
		return nil, err
	}
	st, err := sqlite.New(config.Config.SqlitePath)
	if err != nil {
		return nil, err
	}
	if err := st.CheckDb(); err != nil {
		return nil, err
	}
	return st, nil
}

func doInvite(configPath string, days int) error {
	st, err := openStore(configPath)
	if err != nil {
		return err
	}
	defer st.Close()
	_, priv, err := relay.LoadOrCreateKey(st)
	if err != nil {
		return err
	}
	var expires int64
	if days > 0 {
		expires = time.Now().Add(time.Duration(days) * 24 * time.Hour).UnixMilli()
	}
	inv, err := relay.NewInvite(priv, expires)
	if err != nil {
		return err
	}
	code, err := inv.Encode()
	if err != nil {
		return err
	}
	fmt.Println(code)
	if days > 0 {
		fmt.Fprintf(os.Stderr, "single-use, expires in %d day(s)\n", days)
	} else {
		fmt.Fprintln(os.Stderr, "single-use, no expiry")
	}
	return nil
}

func parseMember(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("expected a 64-hex member key, got %q", s)
	}
	return b, nil
}

func doAllow(configPath, memberHex string) error {
	st, err := openStore(configPath)
	if err != nil {
		return err
	}
	defer st.Close()
	pub, err := parseMember(memberHex)
	if err != nil {
		return err
	}
	if err := st.AllowMember(pub, "operator", time.Now().UnixMilli()); err != nil {
		return err
	}
	fmt.Printf("allowed %s (%s)\n", memberHex, identity.Fingerprint(pub))
	return nil
}

func doDisallow(configPath, memberHex string) error {
	st, err := openStore(configPath)
	if err != nil {
		return err
	}
	defer st.Close()
	pub, err := parseMember(memberHex)
	if err != nil {
		return err
	}
	if err := st.RemoveAllowed(pub); err != nil {
		return err
	}
	fmt.Printf("removed %s\n", memberHex)
	return nil
}

func doAllowlist(configPath string) error {
	st, err := openStore(configPath)
	if err != nil {
		return err
	}
	defer st.Close()
	list, err := st.ListAllowed()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Println("allow-list is empty.")
		return nil
	}
	fmt.Printf("%d member(s) admitted:\n", len(list))
	for _, m := range list {
		fmt.Printf("  %x  %-8s  %s\n", m.MemberPub, m.Via, identity.Fingerprint(m.MemberPub))
	}
	return nil
}
