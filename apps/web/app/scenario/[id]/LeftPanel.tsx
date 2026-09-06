'use client';

import type { MaterialsList, MemoryNote } from '../_lib';
import type { SceneNavItem } from '../scenario-nav';
import { Soderjanie, type SceneDragProps } from './Soderjanie';
import { MirProekta } from './MirProekta';

interface LeftPanelProps {
  scenes: SceneNavItem[];
  currentIndex: number;
  notes: MemoryNote[];
  materials: MaterialsList;
  canonCount: number;
  onJump: (offset: number) => void;
  onAddScene: (after: SceneNavItem | null) => void;
  onAddSynopsis: (scene: SceneNavItem) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onAddNote: (text: string) => Promise<void> | void;
  onRemoveNote: (id: string) => Promise<void> | void;
  onToggleNoteContext: (id: string) => Promise<void> | void;
  onUploadFile: (file: File) => Promise<string | null>;
  onRemoveMaterial: (id: string) => void;
  onToggleMaterialContext: (id: string, includeInAi: boolean) => Promise<void> | void;
  persistenceError: string | null;
  onRetryPersistence: () => Promise<void> | void;
  dragProps: SceneDragProps;
}

/**
 * Left rail (spec §4): two floating plaques, 50/50 — СОДЕРЖАНИЕ (scene
 * navigator) on top, МИР ПРОЕКТА (canon notes + files) below.
 */
export function LeftPanel(props: LeftPanelProps) {
  return (
    <aside
      aria-label="Навигация и мир проекта"
      className="hidden w-[340px] shrink-0 flex-col gap-4 overflow-hidden border-r-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] p-3 lg:flex"
      data-testid="scenario-left"
    >
      <Soderjanie
        scenes={props.scenes}
        currentIndex={props.currentIndex}
        onJump={props.onJump}
        onAddScene={props.onAddScene}
        onAddSynopsis={props.onAddSynopsis}
        onReorder={props.onReorder}
        dragProps={props.dragProps}
      />
      <MirProekta
        notes={props.notes}
        materials={props.materials}
        canonCount={props.canonCount}
        onAddNote={props.onAddNote}
        onRemoveNote={props.onRemoveNote}
        onToggleNoteContext={props.onToggleNoteContext}
        onUploadFile={props.onUploadFile}
        onRemoveMaterial={props.onRemoveMaterial}
        onToggleMaterialContext={props.onToggleMaterialContext}
        persistenceError={props.persistenceError}
        onRetryPersistence={props.onRetryPersistence}
      />
    </aside>
  );
}
