package event

import (
	"bytes"
	"sort"

	cairnv1 "github.com/geekgonecrazy/cairn/proto/cairnv1"
)

// A room is an append-only set of signed events with causal `parents`. Merge is
// hash-set union (event_id dedups) → commutative, associative, idempotent, so
// the same set yields the same view on every node. See docs/protocol.md §4.
//
// This file holds the pure, store-independent DAG primitives. Head maintenance
// against persisted storage lives in store/sqlite; incremental sync (the
// frontier diff) lands in Phase 1.

// Heads returns the event_ids in the set that are not a parent of any other
// event in the set — the current frontier. Result is sorted ascending for a
// canonical, comparable head list. Events must all belong to one room.
func Heads(events []*cairnv1.Event) [][]byte {
	isParent := make(map[string]bool, len(events))
	for _, e := range events {
		for _, p := range e.Parents {
			isParent[string(p)] = true
		}
	}
	var heads [][]byte
	for _, e := range events {
		if !isParent[string(e.EventId)] {
			heads = append(heads, e.EventId)
		}
	}
	sort.Slice(heads, func(i, j int) bool { return bytes.Compare(heads[i], heads[j]) < 0 })
	return heads
}

// IDLess is the concurrent-event tiebreak: among events where neither is an
// ancestor of the other, the one with the lexicographically lower event_id
// sorts first. Causal ordering (ancestry) takes precedence over this and is
// resolved by the caller walking `parents`; IDLess only breaks true ties.
func IDLess(a, b []byte) bool { return bytes.Compare(a, b) < 0 }
