"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

// MapLibre and deck.gl need `window`, so the map is client-only.
const BoatMap = dynamic(() => import("./BoatMap"), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm opacity-60">Loading map…</div>,
});

let webgl2: boolean | null = null;
function hasWebGL2(): boolean {
  webgl2 ??= !!document.createElement("canvas").getContext("webgl2");
  return webgl2;
}

export default function BoatMapLoader() {
  // null during server render; true/false once in the browser.
  const supported = useSyncExternalStore(
    () => () => {},
    hasWebGL2,
    () => null,
  );
  if (supported === null) return null;
  if (!supported) return <NoWebGL2 />;
  return <BoatMap />;
}

function NoWebGL2() {
  return (
    <div className="grid h-dvh place-items-center p-6">
      <div className="max-w-md space-y-3 text-sm leading-relaxed">
        <h1 className="text-lg font-semibold">This browser can’t draw the map</h1>
        <p>
          The map needs WebGL2, and this browser has it turned off. That usually means hardware acceleration is off or
          the graphics driver is blocked, which is common in virtual machines.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Open the page in a browser on a machine with a real GPU (any current phone or laptop works).</li>
          <li>In Chrome, turn on “Use graphics acceleration when available” in Settings → System, then check chrome://gpu.</li>
          <li>In a VMware VM, turn on “Accelerate 3D graphics” in the VM’s Display settings.</li>
          <li>
            Chrome blocks WebGL on some unstable drivers, VMware’s included. Overriding the blocklist on VMware makes
            the graphics driver crash, so in a VM, start Chrome with software rendering instead:{" "}
            <code>--use-angle=swiftshader --enable-unsafe-swiftshader</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}
