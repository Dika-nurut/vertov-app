export interface AsrWord {
  word: string;
  startSec: number;
  endSec: number;
}

export interface AsrSegment {
  text: string;
  startSec: number;
  endSec: number;
  /** Per-word timings, when the provider returns word-level granularity. Absent
   * for providers/servers without word support — every existing path stays
   * byte-identical when this is undefined. Powers the studio word-pop captions. */
  words?: AsrWord[];
}

export interface AsrProvider {
  transcribe(audioUrl: string, language?: string): Promise<AsrSegment[]>;
}

/** Env vars consumed by the ASR factory. */
export interface AsrEnv {
  /** Base URL of the self-hosted faster-whisper-server (OpenAI-compatible STT API).
   * Example: http://whisper:8000 */
  WHISPER_SERVER_URL?: string;
  /** Model name to request from the whisper server. Defaults to "small". */
  WHISPER_MODEL?: string;
  /** Groq API key — activates the Groq Whisper fallback. */
  GROQ_API_KEY?: string;
  /** If "groq", forces Groq even when WHISPER_SERVER_URL is set. */
  ASR_PROVIDER?: string;
  /** Per-language override: comma-separated "lang:provider" pairs.
   * Example: "uz:groq,en:whisper" */
  ASR_LANG_OVERRIDES?: string;
}
