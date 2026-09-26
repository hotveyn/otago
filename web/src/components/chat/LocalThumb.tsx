import { useEffect, useState } from 'react';

/** Thumbnail of a local (not yet uploaded) image. The object URL lives only in the effect. */
export function LocalThumb({ file, className }: { file: File; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file]);
  if (!url) return null;
  return <img className={className} src={url} alt="" />;
}
