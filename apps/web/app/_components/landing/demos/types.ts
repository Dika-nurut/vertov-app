/** Shared contract for the three FeatureTabs demos. Each demo runs its own rAF
 *  loop while `active`, reports normalized progress (0..1) for the sprocket
 *  sub-beats, and fires `onLoop` once per completed cycle so FeatureTabs can
 *  auto-advance to the next tab (goal §3–§4). */
export type DemoProps = {
  active: boolean;
  onProgress?: (p: number) => void;
  onLoop?: () => void;
};
