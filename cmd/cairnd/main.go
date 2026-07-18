// Command cairnd is the Cairn server binary: a single Capsule workload exposing
// the ConnectRPC API + SSE realtime over the room DAG. Entrypoint only —
// config.Load → core.Setup → router.Start, nothing else (rfd-tool convention).
package main

import (
	"flag"
	"log"

	"github.com/geekgonecrazy/cairn/config"
	"github.com/geekgonecrazy/cairn/core"
	"github.com/geekgonecrazy/cairn/router"
)

func main() {
	configFile := flag.String("configFile", "config.yaml", "path to config file")
	flag.Parse()

	if err := config.Load(*configFile); err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := core.Setup(); err != nil {
		log.Fatalf("core setup: %v", err)
	}
	if err := router.Start(); err != nil {
		log.Fatalf("router: %v", err)
	}
}
