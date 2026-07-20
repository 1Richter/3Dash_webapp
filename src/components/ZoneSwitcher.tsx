import { Layers } from 'lucide-react';
import LucideIcon from './SidePanel/cards/LucideIcon';
import type { ZoneConfig } from '../types';
import './ZoneSwitcher.css';

interface Props {
  zones: ZoneConfig[];
  activeZoneId: string | null;
  /** null = show everything (no zone filter). */
  onSelect: (zoneId: string | null) => void;
}

/**
 * Always-visible vertical stack of floor/area buttons on the left edge of
 * the canvas — the indoor-level-picker pattern from Google Maps (malls,
 * airports), rather than a menu that has to be opened first. Top of the
 * stack is the first configured zone (highest floor, by convention); "All"
 * pins to the bottom like a ground-level "lobby" entry.
 */
export default function ZoneSwitcher({ zones, activeZoneId, onSelect }: Props) {
  if (zones.length === 0) return null;

  return (
    <div className="zone-switcher" role="menu" aria-label="Switch floor">
      {zones.map((z) => (
        <button
          key={z.id}
          role="menuitem"
          title={z.name}
          aria-label={z.name}
          aria-current={activeZoneId === z.id}
          className={`zone-level${activeZoneId === z.id ? ' active' : ''}`}
          onClick={() => onSelect(z.id)}
        >
          {z.icon ? <LucideIcon name={z.icon} size={18} /> : <Layers size={18} />}
        </button>
      ))}
      <button
        role="menuitem"
        title="All floors"
        aria-label="All floors"
        aria-current={activeZoneId === null}
        className={`zone-level zone-level-all${activeZoneId === null ? ' active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <Layers size={18} />
      </button>
    </div>
  );
}
