// Monotonic client-side uid for timeline/text clips. Module-scoped so every
// caller (StudioClient's add* helpers + useTimeline's split/dup/freeze/reorder)
// shares one counter — extracted unchanged from StudioClient (§C step 4).
let uidc = 0;
export const nextUid = () => `tl-${++uidc}-${Date.now().toString(36)}`;
