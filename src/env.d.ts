/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by src/middleware.ts on every HTML request (Lane A). */
    attribution: import('./lib/attribution').Attribution;
  }
}
