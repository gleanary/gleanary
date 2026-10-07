'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  FileText,
  Highlighter,
  CalendarCheck,
  Rss,
  Mail,
  Settings,
  PanelLeft,
  ChevronRight,
  MoreHorizontal,
  Brain,
  MessageSquare,
  Home,
  PenLine,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { isMobileDevice } from '@/lib/is-mobile';
import { useSidebar } from './sidebar-context';
import { Button } from '@/components/ui/button';
import { AddContentButton } from '@/components/inbox/add-content-button';
import { UsageFooter } from '@/components/sidebar/usage-footer';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export const SIDEBAR_WIDTH = 280;

const ICON_SIZE = 18;

export interface SidebarData {
  counts: {
    inbox: number;
    reading: number;
    archived: number;
    allArticles: number;
    dueReviews: number;
  };
  feeds: Array<{ id: number; name: string; iconUrl: string | null }>;
}

interface NavItemProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  count?: number;
  isActive: boolean;
  onClick?: () => void;
}

function NavItem({ href, label, icon, count, isActive, onClick }: NavItemProps) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count != null && count > 0 && (
        <span className="bg-sidebar-accent text-sidebar-accent-foreground min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-medium">
          {count}
        </span>
      )}
    </Link>
  );
}

interface MenuItem {
  label: string;
  href: string;
}

interface NavItemWithMenuProps extends NavItemProps {
  menuItems: MenuItem[];
}

function NavItemWithMenu({ menuItems, label, ...navProps }: NavItemWithMenuProps) {
  return (
    <div className="group relative">
      <NavItem label={label} {...navProps} />
      <div className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground dark:hover:bg-sidebar-accent"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              aria-label={`${label} options`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            {menuItems.map((item) => (
              <DropdownMenuItem key={item.href} asChild>
                <Link href={item.href}>{item.label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

interface NavItemWithCollapsibleProps extends NavItemProps {
  children: React.ReactNode;
}

function NavItemWithCollapsible({
  children,
  href,
  label,
  icon,
  count,
  isActive,
  onClick,
}: NavItemWithCollapsibleProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="text-sidebar-foreground/50 hover:text-sidebar-foreground/70 ml-1 size-4 hover:bg-transparent dark:hover:bg-transparent"
          aria-label={isExpanded ? `Collapse ${label}` : `Expand ${label}`}
        >
          <ChevronRight
            className={cn('transition-transform duration-150', isExpanded && 'rotate-90')}
          />
        </Button>
        <div className="flex-1">
          <NavItem
            href={href}
            label={label}
            icon={icon}
            count={count}
            isActive={isActive}
            onClick={onClick}
          />
        </div>
      </div>
      {isExpanded && <div className="ml-6 pl-2">{children}</div>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sidebar-foreground/50 px-3 pt-4 pb-1 text-[11px] font-semibold tracking-wider uppercase">
      {children}
    </p>
  );
}

/**
 * Sidebar navigation panel with article counts, feed/newsletter lists, and settings.
 * @param props.data - Server-fetched sidebar data (counts, feeds, newsletters)
 * @returns The sidebar aside element
 */
export function Sidebar({ data, onOpenSearch }: { data: SidebarData; onOpenSearch?: () => void }) {
  const { isOpen, close } = useSidebar();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSourceId = pathname === '/inbox' ? searchParams.get('source') : null;

  // On mobile, close sidebar after navigating; on desktop, keep it open
  const handleNav = isMobileDevice ? close : undefined;

  // On mobile, go straight to the search page; on desktop, open the search palette
  const handleSearch = () => {
    if (isMobileDevice) {
      close();
      router.push('/search');
    } else {
      onOpenSearch?.();
    }
  };

  return (
    <aside
      style={{ width: SIDEBAR_WIDTH }}
      className={cn(
        'border-sidebar-border fixed inset-y-0 left-0 z-40 flex flex-col border-r',
        'bg-sidebar text-sidebar-foreground',
        'transition-transform duration-250 ease-out',
        isOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      {/* Header — pinned */}
      <div className="flex items-center justify-between px-4 py-4">
        <span className="text-lg font-semibold">Gleanary</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={close}
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-transparent dark:hover:bg-transparent"
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleSearch}
            aria-label="Search (Cmd+K)"
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-transparent dark:hover:bg-transparent"
          >
            <Search className="size-5" />
          </Button>
          <AddContentButton triggerClassName="text-sidebar-foreground/60 hover:bg-transparent hover:text-sidebar-foreground dark:hover:bg-transparent" />
        </div>
      </div>

      {/* Scrollable nav area */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        <NavItem
          href="/"
          label="Home"
          icon={<Home size={ICON_SIZE} />}
          isActive={pathname === '/'}
          onClick={handleNav}
        />
        <NavItemWithCollapsible
          href="/inbox"
          label="Library"
          icon={<FileText size={ICON_SIZE} />}
          count={data.counts.allArticles}
          isActive={
            pathname === '/inbox' &&
            !activeSourceId &&
            !searchParams.get('sourceType') &&
            !searchParams.get('excludeSourceType')
          }
          onClick={handleNav}
        >
          <NavItem
            href="/inbox?excludeSourceType=newsletter"
            label="Articles"
            icon={<FileText size={ICON_SIZE} />}
            isActive={
              pathname === '/inbox' && searchParams.get('excludeSourceType') === 'newsletter'
            }
            onClick={handleNav}
          />
          <NavItemWithMenu
            href="/inbox?sourceType=newsletter"
            label="Emails"
            icon={<Mail size={ICON_SIZE} />}
            isActive={pathname === '/inbox' && searchParams.get('sourceType') === 'newsletter'}
            onClick={handleNav}
            menuItems={[{ label: 'Manage Emails', href: '/newsletters' }]}
          />
          <NavItem
            href="/inbox?sourceType=upload"
            label="PDFs"
            icon={<FileText size={ICON_SIZE} />}
            isActive={pathname === '/inbox' && searchParams.get('sourceType') === 'upload'}
            onClick={handleNav}
          />
        </NavItemWithCollapsible>

        <SectionLabel>Highlights</SectionLabel>
        <NavItem
          href="/library"
          label="Browse"
          icon={<Highlighter size={ICON_SIZE} />}
          isActive={pathname === '/library'}
          onClick={handleNav}
        />
        <NavItem
          href="/review"
          label="Daily Review"
          icon={<CalendarCheck size={ICON_SIZE} />}
          count={data.counts.dueReviews}
          isActive={pathname === '/review'}
          onClick={handleNav}
        />
        <NavItem
          href="/theses"
          label="Theses"
          icon={<Brain size={ICON_SIZE} />}
          isActive={pathname.startsWith('/theses')}
          onClick={handleNav}
        />
        <NavItem
          href="/drafts"
          label="Drafts"
          icon={<PenLine size={ICON_SIZE} />}
          isActive={pathname.startsWith('/drafts')}
          onClick={handleNav}
        />
        <NavItem
          href="/chat"
          label="Chat"
          icon={<MessageSquare size={ICON_SIZE} />}
          isActive={pathname.startsWith('/chat')}
          onClick={handleNav}
        />

        {data.feeds.length > 0 && (
          <>
            <SectionLabel>Feeds</SectionLabel>
            {data.feeds.map((feed) => (
              <NavItem
                key={feed.id}
                href={`/inbox?source=${feed.id}`}
                label={feed.name}
                icon={<Rss size={ICON_SIZE} />}
                isActive={pathname === '/inbox' && activeSourceId === String(feed.id)}
                onClick={handleNav}
              />
            ))}
          </>
        )}
      </nav>

      {/* Footer — pinned */}
      <div className="border-sidebar-border border-t px-2 pt-2">
        <UsageFooter />
        <NavItem
          href="/settings"
          label="Settings"
          icon={<Settings size={ICON_SIZE} />}
          isActive={pathname === '/settings'}
          onClick={handleNav}
        />
      </div>
    </aside>
  );
}
