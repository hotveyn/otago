import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { chainIds, nameOf } from '../../lib/tree';

interface IdPathProps {
  /** Node id (`''` = the tree root). */
  id: string;
  /** Ignored: lets `<Trans components={{ code: <IdPath … /> }}>` pass its text through. */
  children?: ReactNode;
}

/**
 * A node id as a path. Each segment is isolated in `<bdi>` inside an LTR `<code>`, so a
 * right-to-left segment never reorders the path around it.
 */
export function IdPath({ id }: IdPathProps) {
  const { t } = useTranslation();
  if (id === '') return <code dir="ltr">{t('root')}</code>;
  return (
    <code dir="ltr" className="id-path">
      {chainIds(id).map((path, index) => (
        <Fragment key={path}>
          {index > 0 && '/'}
          <bdi>{nameOf(path)}</bdi>
        </Fragment>
      ))}
    </code>
  );
}
