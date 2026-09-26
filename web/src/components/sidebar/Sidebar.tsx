import { useTranslation } from 'react-i18next';
import type { TreeDetail, TreeMeta } from '../../api/types';
import { LanguageSwitcher } from './LanguageSwitcher';
import { SourcesPanel } from './SourcesPanel';
import { ThemeSwitcher } from './ThemeSwitcher';
import { TreeList } from './TreeList';
import { TreeSettings } from './TreeSettings';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  trees: TreeMeta[];
  treesError: unknown;
  tree: TreeDetail | null;
  currentTreeId: string | null;
  onSelectTree: (id: string) => void;
}

export function Sidebar({
  collapsed,
  onToggle,
  trees,
  treesError,
  tree,
  currentTreeId,
  onSelectTree,
}: SidebarProps) {
  const { t } = useTranslation('sidebar');
  return (
    <aside className={collapsed ? 'sidebar sidebar-collapsed' : 'sidebar'}>
      <div className="sidebar-top">
        {!collapsed && (
          <div className="brand">
            <span className="brand-mark">Otago</span>
            <span className="brand-sub">{t('brandSub')}</span>
          </div>
        )}
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls="sidebar-body"
          aria-label={collapsed ? t('expand') : t('collapse')}
          title={collapsed ? t('expandHint') : t('collapseHint')}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="1.5"
              fill="none"
              stroke="currentColor"
            />
            <path d="M6 2.5v11" stroke="currentColor" />
            <path
              d={collapsed ? 'M9 6l2 2-2 2' : 'M11 6L9 8l2 2'}
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {/* Kept mounted while collapsed so half-typed settings survive a toggle. */}
      <div id="sidebar-body" className="sidebar-body" hidden={collapsed}>
        <TreeList
          trees={trees}
          error={treesError}
          currentId={currentTreeId}
          onSelect={onSelectTree}
        />
        {tree && (
          <>
            <TreeSettings key={tree.id} tree={tree} />
            <SourcesPanel treeId={tree.id} />
          </>
        )}
        <div className="sidebar-footer">
          <ThemeSwitcher />
          <LanguageSwitcher />
        </div>
      </div>
    </aside>
  );
}
