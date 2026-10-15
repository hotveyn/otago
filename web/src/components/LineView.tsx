import { useEffect, useRef } from 'react';

interface LineViewProps {
  text: string;
  /** 1-based first line to scroll into view; `start..end` is highlighted. */
  start?: number;
  end?: number;
}

/** Numbered lines of a text file with an optional highlighted range (sources and user files). */
export function LineView({ text, start, end }: LineViewProps) {
  const highlight = useRef<HTMLDivElement>(null);
  const last = end ?? start;
  const lines = text.replace(/\n$/, '').split('\n');

  // Re-scroll when the text arrives or the cited range changes; out of range → no element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text/start/last drive the scroll
  useEffect(() => {
    highlight.current?.scrollIntoView({ block: 'center' });
  }, [text, start, last]);

  return (
    <div className="lines">
      {lines.map((line, index) => {
        const number = index + 1;
        const inRange =
          start !== undefined && last !== undefined && number >= start && number <= last;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            key={index}
            ref={number === start ? highlight : undefined}
            className={inRange ? 'line line-hit' : 'line'}
          >
            <span className="line-no">{number}</span>
            <span className="line-text">{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
