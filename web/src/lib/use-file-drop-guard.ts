import { useEffect } from 'react';

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Keep the browser from navigating to a file dropped outside a drop zone.
 * Drop zones (composer, Sources panel) handle the event first in React and call
 * `preventDefault` themselves, so they are skipped here; propagation is never stopped.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
