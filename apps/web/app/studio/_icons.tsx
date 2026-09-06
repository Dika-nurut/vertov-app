// Studio icon barrel — Phosphor, weight="bold" by default (owner mandate; never
// lucide, never duotone). Re-exports under the studio's prior lucide names so the
// module-wide swap is a single import-path change per file (no call-site renames).
// Callers may still override any prop (size/className/weight/color).
//
// Imported from `@phosphor-icons/react/dist/ssr` (RSC/SSR-safe; IconContext is NOT
// in that entry, which is why each icon is wrapped to carry the default weight).
import type { ComponentProps, ComponentType } from 'react';
import {
  ArrowCounterClockwise as PhArrowCounterClockwise,
  ArrowsLeftRight as PhArrowsLeftRight,
  ArrowUpRight as PhArrowUpRight,
  ArrowUUpLeft as PhArrowUUpLeft,
  ArrowUUpRight as PhArrowUUpRight,
  CaretDown as PhCaretDown,
  Check as PhCheck,
  CircleNotch as PhCircleNotch,
  ClosedCaptioning as PhClosedCaptioning,
  Copy as PhCopy,
  Crop as PhCrop,
  Diamond as PhDiamond,
  DownloadSimple as PhDownloadSimple,
  FilmSlate as PhFilmSlate,
  FilmStrip as PhFilmStrip,
  FlipHorizontal as PhFlipHorizontal,
  FlipVertical as PhFlipVertical,
  FolderOpen as PhFolderOpen,
  FrameCorners as PhFrameCorners,
  Gauge as PhGauge,
  GearSix as PhGearSix,
  GridFour as PhGridFour,
  CircleHalf as PhCircleHalf,
  Intersect as PhIntersect,
  LineVertical as PhLineVertical,
  Lightning as PhLightning,
  Lock as PhLock,
  LockOpen as PhLockOpen,
  Magnet as PhMagnet,
  MagnifyingGlass as PhMagnifyingGlass,
  MagnifyingGlassMinus as PhMagnifyingGlassMinus,
  MagnifyingGlassPlus as PhMagnifyingGlassPlus,
  Microphone as PhMicrophone,
  MusicNotes as PhMusicNotes,
  Palette as PhPalette,
  Pause as PhPause,
  PenNib as PhPenNib,
  Play as PhPlay,
  Plus as PhPlus,
  Rectangle as PhRectangle,
  Rewind as PhRewind,
  Scissors as PhScissors,
  Snowflake as PhSnowflake,
  SlidersHorizontal as PhSlidersHorizontal,
  Sparkle as PhSparkle,
  SpeakerHigh as PhSpeakerHigh,
  SpeakerSlash as PhSpeakerSlash,
  Selection as PhSelection,
  Stack as PhStack,
  Sun as PhSun,
  TextT as PhTextT,
  Trash as PhTrash,
  UploadSimple as PhUploadSimple,
  X as PhX,
} from '@phosphor-icons/react/dist/ssr';

type IconProps = ComponentProps<typeof PhPlus>;

/** Wrap a Phosphor icon so it defaults to weight="bold" without a per-call repeat. */
const bold = (Icon: ComponentType<IconProps>): ComponentType<IconProps> =>
  function BoldIcon(props: IconProps) {
    return <Icon weight="bold" {...props} />;
  };

// --- exports keyed to the studio's prior (lucide) names -------------------------
export const ArrowLeftRight = bold(PhArrowsLeftRight);
export const ArrowUpRight = bold(PhArrowUpRight);
export const Captions = bold(PhClosedCaptioning);
export const CaretDown = bold(PhCaretDown);
export const Check = bold(PhCheck);
export const CircleHalf = bold(PhCircleHalf);
export const Diamond = bold(PhDiamond);
export const Clapperboard = bold(PhFilmSlate);
export const Copy = bold(PhCopy);
export const Crop = bold(PhCrop);
export const Download = bold(PhDownloadSimple);
export const Film = bold(PhFilmStrip);
export const FlipHorizontal = bold(PhFlipHorizontal);
export const FlipVertical = bold(PhFlipVertical);
export const FolderOpen = bold(PhFolderOpen);
export const Gauge = bold(PhGauge);
export const Grid3x3 = bold(PhGridFour);
export const Intersect = bold(PhIntersect);
export const Layers = bold(PhStack);
export const LineVertical = bold(PhLineVertical);
export const Loader2 = bold(PhCircleNotch);
export const Lock = bold(PhLock);
export const Magnet = bold(PhMagnet);
export const Maximize2 = bold(PhFrameCorners);
export const Mic = bold(PhMicrophone);
export const Music = bold(PhMusicNotes);
export const Palette = bold(PhPalette);
export const Pause = bold(PhPause);
export const PenNib = bold(PhPenNib);
export const Play = bold(PhPlay);
export const Plus = bold(PhPlus);
export const Proportions = bold(PhRectangle);
export const Redo2 = bold(PhArrowUUpRight);
export const Rewind = bold(PhRewind);
export const Search = bold(PhMagnifyingGlass);
export const Snowflake = bold(PhSnowflake);
export const RotateCcw = bold(PhArrowCounterClockwise);
export const Scissors = bold(PhScissors);
export const Selection = bold(PhSelection);
export const Settings2 = bold(PhGearSix);
export const Sun = bold(PhSun);
export const SlidersHorizontal = bold(PhSlidersHorizontal);
export const Sparkles = bold(PhSparkle);
export const Trash2 = bold(PhTrash);
export const Type = bold(PhTextT);
export const Undo2 = bold(PhArrowUUpLeft);
export const Unlock = bold(PhLockOpen);
export const UploadCloud = bold(PhUploadSimple);
export const Volume2 = bold(PhSpeakerHigh);
export const VolumeX = bold(PhSpeakerSlash);
export const X = bold(PhX);
export const Zap = bold(PhLightning);
export const ZoomIn = bold(PhMagnifyingGlassPlus);
export const ZoomOut = bold(PhMagnifyingGlassMinus);
