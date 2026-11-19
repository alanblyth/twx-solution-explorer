export type Tab = 'extensions' | 'containers' | 'entities';

const TABS: Tab[] = ['extensions', 'containers', 'entities'];

/** The tab to open first for a StartTab value; anything unknown (or empty) opens the Extensions tab. */
export function startTabOf(value: string | null | undefined): Tab {
  const cleaned = (value ?? '').trim().toLowerCase();
  return (TABS as string[]).includes(cleaned) ? (cleaned as Tab) : 'extensions';
}
