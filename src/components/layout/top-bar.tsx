'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HamburgerButton } from './hamburger-button';

/**
 * Muted→foreground pill button: a thin wrapper over `Button` (ghost/sm). Used for TopBar
 * actions and for tab/filter pill rows elsewhere (e.g. the newsletter status tabs) — the name
 * reflects the visual treatment, not a placement constraint. Pass `asChild` to wrap a `Link`;
 * pass an active className (e.g. `bg-secondary text-foreground font-medium`) for selected states.
 * @param props - Standard `Button` props (variant/size are fixed; `className` is merged)
 * @returns A pill-styled button
 */
export function TopBarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'text-muted-foreground hover:bg-secondary/50 hover:text-foreground font-normal',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Shared top bar used across all pages. Renders the sidebar toggle and page-specific content.
 * @param props.children - Page-specific toolbar content
 * @param props.hideSidebarToggleOnMobile - Hide the hamburger button on mobile (default: false)
 * @param props.className - Additional classes for the inner flex container
 * @returns Sticky top bar element
 */
export function TopBar({
  children,
  hideSidebarToggleOnMobile = false,
  className,
}: {
  children: React.ReactNode;
  hideSidebarToggleOnMobile?: boolean;
  className?: string;
}) {
  return (
    <div className="border-border bg-background/95 sticky top-0 z-10 border-b backdrop-blur-sm">
      <div className={cn('flex min-h-12 items-center gap-1 px-1 py-2', className)}>
        <HamburgerButton className={hideSidebarToggleOnMobile ? 'hidden md:block' : undefined} />
        {children}
      </div>
    </div>
  );
}
