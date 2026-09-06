// App-wide icon barrel — the Vertov icon system (SPEC 06-05, docket D6).
//
// lucide is banned. Every icon resolves to one of two sources, keyed to the old
// lucide name so a migrating file only changes its import PATH:
//   • the 7×7 <PixelGlyph> family, where a glyph exists for the concept, or
//   • Phosphor **bold** — the transitional fallback for concepts the family does
//     not yet carry (same rule the Studio icon barrel already follows).
//
// Imported from `@phosphor-icons/react/dist/ssr` (RSC/SSR-safe; IconContext is not
// in that entry, so each icon is wrapped to carry weight="bold").

import type { ComponentType, CSSProperties, MouseEventHandler } from 'react';
import {
  Archive as PhArchive,
  ArrowRight as PhArrowRight,
  ArrowsClockwise as PhArrowsClockwise,
  ArrowUpRight as PhArrowUpRight,
  ArrowUUpLeft as PhArrowUUpLeft,
  ArrowUUpRight as PhArrowUUpRight,
  Bell as PhBell,
  Camera as PhCamera,
  CaretLeft as PhCaretLeft,
  CaretUp as PhCaretUp,
  Check as PhCheck,
  CheckCircle as PhCheckCircle,
  Circle as PhCircle,
  CircleNotch as PhCircleNotch,
  Clock as PhClock,
  Copy as PhCopy,
  CornersOut as PhCornersOut,
  Cpu as PhCpu,
  Cursor as PhCursor,
  DeviceMobile as PhDeviceMobile,
  DotsSixVertical as PhDotsSixVertical,
  DownloadSimple as PhDownloadSimple,
  File as PhFile,
  FilmSlate as PhFilmSlate,
  FilmStrip as PhFilmStrip,
  GearSix as PhGearSix,
  GitBranch as PhGitBranch,
  GridFour as PhGridFour,
  Hand as PhHand,
  ImageBroken as PhImageBroken,
  Info as PhInfo,
  Keyboard as PhKeyboard,
  Lightning as PhLightning,
  LinkBreak as PhLinkBreak,
  ListChecks as PhListChecks,
  LockSimple as PhLockSimple,
  MagicWand as PhMagicWand,
  MagnifyingGlass as PhMagnifyingGlass,
  MagnifyingGlassMinus as PhMagnifyingGlassMinus,
  MagnifyingGlassPlus as PhMagnifyingGlassPlus,
  MapPin as PhMapPin,
  MapTrifold as PhMapTrifold,
  Minus as PhMinus,
  Monitor as PhMonitor,
  Note as PhNote,
  PaperPlaneTilt as PhPaperPlaneTilt,
  PencilSimple as PhPencilSimple,
  Pulse as PhPulse,
  Scan as PhScan,
  ShieldCheck as PhShieldCheck,
  SignOut as PhSignOut,
  Sparkle as PhSparkle,
  SpeakerSlash as PhSpeakerSlash,
  Star as PhStar,
  TextT as PhTextT,
  Trash as PhTrash,
  Tray as PhTray,
  User as PhUser,
  Warning as PhWarning,
  WarningCircle as PhWarningCircle,
  X as PhX,
  XCircle as PhXCircle,
} from '@phosphor-icons/react/dist/ssr';
import { PixelGlyph } from './pixel-glyph';
import type { PixelGlyphName } from '@/lib/pixel-glyph-data';

// A permissive superset of the props lucide / Phosphor / PixelGlyph call sites
// pass. `strokeWidth` is a lucide-ism with no meaning here — accepted so generic
// `ComponentType<{…strokeWidth?}>` icon stores keep type-checking, then dropped.
export interface IconProps {
  size?: number | string;
  className?: string;
  color?: string;
  fill?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  role?: string;
}

/** Phosphor icon defaulting to weight="bold"; drops the lucide-only strokeWidth. */
const bold = (Icon: ComponentType<Record<string, unknown>>): ComponentType<IconProps> =>
  function BoldIcon({ strokeWidth: _sw, ...rest }: IconProps) {
    return <Icon weight="bold" {...rest} />;
  };

/** A pixel-glyph family member wrapped under a lucide-compatible name. */
const glyph = (name: PixelGlyphName): ComponentType<IconProps> =>
  function GlyphIcon({ strokeWidth: _sw, color: _c, size, className, ...rest }: IconProps) {
    return (
      <PixelGlyph
        name={name}
        className={className}
        {...(typeof size === 'number' ? { size } : {})}
        {...rest}
      />
    );
  };

// --- family glyphs (render as 7×7 pixel glyphs) ---------------------------------
export const Image = glyph('image');
export const ImageIcon = glyph('image');
export const Images = glyph('image');
export const Play = glyph('video'); // the play triangle
export const Plus = glyph('add');
export const X = glyph('remove'); // the × glyph
export const ChevronDown = glyph('expand');
export const ChevronRight = glyph('catalog');
export const Volume2 = glyph('sound');
export const Upload = glyph('upload'); // the ⤓ drop/upload affordance

// --- Phosphor bold fallback (no family glyph yet) -------------------------------
export const Activity = bold(PhPulse);
export const AlertCircle = bold(PhWarningCircle);
export const Archive = bold(PhArchive);
export const ArrowRight = bold(PhArrowRight);
export const ArrowUpRight = bold(PhArrowUpRight);
export const Bell = bold(PhBell);
export const Camera = bold(PhCamera);
export const Check = bold(PhCheck);
export const CheckCircle2 = bold(PhCheckCircle);
export const ChevronLeft = bold(PhCaretLeft);
export const ChevronUp = bold(PhCaretUp);
export const Circle = bold(PhCircle);
export const Clapperboard = bold(PhFilmSlate);
export const Clock3 = bold(PhClock);
export const Copy = bold(PhCopy);
export const Cpu = bold(PhCpu);
export const Download = bold(PhDownloadSimple);
export const File = bold(PhFile);
export const Film = bold(PhFilmStrip);
export const GitBranch = bold(PhGitBranch);
export const GripVertical = bold(PhDotsSixVertical);
export const Hand = bold(PhHand);
export const ImageOff = bold(PhImageBroken);
export const Inbox = bold(PhTray);
export const Info = bold(PhInfo);
export const Keyboard = bold(PhKeyboard);
export const LayoutGrid = bold(PhGridFour);
export const Link2Off = bold(PhLinkBreak);
export const ListChecks = bold(PhListChecks);
export const Loader2 = bold(PhCircleNotch);
export const Lock = bold(PhLockSimple);
export const LogOut = bold(PhSignOut);
export const Map = bold(PhMapTrifold);
export const MapPin = bold(PhMapPin);
export const Maximize = bold(PhCornersOut);
export const Minus = bold(PhMinus);
export const Monitor = bold(PhMonitor);
export const MousePointer2 = bold(PhCursor);
export const Pencil = bold(PhPencilSimple);
export const Redo2 = bold(PhArrowUUpRight);
export const Search = bold(PhMagnifyingGlass);
export const RefreshCw = bold(PhArrowsClockwise);
export const Scan = bold(PhScan);
export const Send = bold(PhPaperPlaneTilt);
export const Settings = bold(PhGearSix);
export const Settings2 = bold(PhGearSix);
export const ShieldCheck = bold(PhShieldCheck);
export const Smartphone = bold(PhDeviceMobile);
export const Sparkles = bold(PhSparkle); // wand/«магия» affordance — removed in the copy sweep (BA-26)
export const Star = bold(PhStar);
export const StickyNote = bold(PhNote);
export const FileText = bold(PhNote);
export const Trash2 = bold(PhTrash);
export const TriangleAlert = bold(PhWarning);
export const Type = bold(PhTextT);
export const Undo2 = bold(PhArrowUUpLeft);
export const User = bold(PhUser);
export const UserRound = bold(PhUser);
export const VolumeX = bold(PhSpeakerSlash);
export const Wand = bold(PhMagicWand);
export const Wand2 = bold(PhMagicWand);
export const XCircle = bold(PhXCircle);
export const Zap = bold(PhLightning);
export const ZoomIn = bold(PhMagnifyingGlassPlus);
export const ZoomOut = bold(PhMagnifyingGlassMinus);
