import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import './EntityPicker.css';

export interface HAEntityOption {
  entity_id: string;
  friendly_name?: string;
  device_class?: string;
  area_id?: string;
  area_name?: string;
  labels?: string[];
}

interface Props {
  value: string;
  onChange: (val: string) => void;
  /** Fired when the user picks an entity from the dropdown (not on free typing). */
  onSelect?: (entity: HAEntityOption) => void;
  placeholder?: string;
  entities: HAEntityOption[];
  className?: string;
  /**
   * When set, entities failing this predicate are hidden by default. A
   * "show all" checkbox (labelled `filterToggleLabel`) lets the user disable
   * it. Omit for the old unfiltered behavior (used by every non-door caller).
   */
  filterPredicate?: (e: HAEntityOption) => boolean;
  filterToggleLabel?: string;
  /** Group dropdown results by `area_name` (entities with none go under "Other"). */
  groupByArea?: boolean;
  /** label_id -> info, used to render clickable filter chips above the search input. */
  labelRegistry?: Record<string, { label_id: string; name: string; color?: string }>;
}

const MAX_RESULTS = 50;

export default function EntityPicker({ value, onChange, onSelect, placeholder, entities, className, filterPredicate, filterToggleLabel, groupByArea, labelRegistry }: Props) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const keyboardNavRef = useRef(false);
  const listboxId = useId();
  const [showAll, setShowAll] = useState(false);
  const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set());

  const availableLabelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entities) for (const id of e.labels ?? []) ids.add(id);
    return [...ids];
  }, [entities]);

  const filtered = useMemo(() => {
    if (entities.length === 0) return [];
    let pool = entities;
    if (filterPredicate && !showAll) pool = pool.filter(filterPredicate);
    if (activeLabels.size > 0) {
      // OR across selected chips: an entity matches if it carries ANY active label.
      pool = pool.filter(e => (e.labels ?? []).some(id => activeLabels.has(id)));
    }
    const q = value.toLowerCase();
    if (q) {
      pool = pool.filter(e =>
        e.entity_id.toLowerCase().includes(q) ||
        (e.friendly_name?.toLowerCase().includes(q) ?? false),
      );
    }
    return pool.slice(0, MAX_RESULTS);
  }, [entities, value, filterPredicate, showAll, activeLabels]);

  const grouped = useMemo(() => {
    if (!groupByArea) return null;
    const groups = new Map<string, HAEntityOption[]>();
    for (const e of filtered) {
      const key = e.area_name ?? 'Other';
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b));
  }, [filtered, groupByArea]);

  const select = useCallback((entity: HAEntityOption) => {
    onChange(entity.entity_id);
    onSelect?.(entity);
    setOpen(false);
  }, [onChange, onSelect]);

  const openDropdown = useCallback(() => {
    if (entities.length === 0) return;
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    setHighlighted(0);
    setOpen(true);
  }, [entities.length]);

  // Close when clicking outside (input AND dropdown).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Keep dropdown glued to the input as the user scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  useEffect(() => { setHighlighted(0); }, [value]);

  useEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    itemRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown') openDropdown();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      keyboardNavRef.current = true;
      setHighlighted(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      keyboardNavRef.current = true;
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (filtered[highlighted]) {
        e.preventDefault();
        select(filtered[highlighted]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, filtered, highlighted, select, openDropdown]);

  const dropdownStyle: React.CSSProperties | undefined = rect ? {
    position: 'fixed',
    top: rect.bottom + 2,
    left: rect.left,
    width: rect.width,
    zIndex: 9999,
  } : undefined;

  return (
    <>
      <input
        ref={inputRef}
        value={value}
        onChange={e => { onChange(e.target.value); openDropdown(); }}
        onFocus={openDropdown}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && filtered[highlighted] ? `${listboxId}-${highlighted}` : undefined}
      />
      {open && dropdownStyle && createPortal(
        <div
          ref={dropdownRef}
          className="entity-picker-dropdown"
          style={dropdownStyle}
        >
          {(filterPredicate || (labelRegistry && availableLabelIds.length > 0)) && (
            <div className="entity-picker-controls">
              {filterPredicate && (
                <label className="entity-picker-showall">
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
                  {filterToggleLabel ?? 'Show all entities'}
                </label>
              )}
              {labelRegistry && availableLabelIds.length > 0 && (
                <div className="entity-picker-chips">
                  {availableLabelIds.map(id => {
                    const info = labelRegistry[id];
                    if (!info) return null;
                    const active = activeLabels.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`entity-picker-chip${active ? ' active' : ''}`}
                        style={info.color ? { borderColor: info.color } : undefined}
                        onMouseDown={ev => ev.preventDefault()}
                        onClick={() => setActiveLabels(prev => {
                          const next = new Set(prev);
                          active ? next.delete(id) : next.add(id);
                          return next;
                        })}
                      >
                        {info.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="entity-picker-empty">No matching entities.</div>
          ) : (
            <div id={listboxId} role="listbox">
              {(grouped ?? [['', filtered]] as [string, HAEntityOption[]][]).map(([groupName, groupEntities]) => (
                <div key={groupName || '_flat'}>
                  {grouped && <div className="entity-picker-group-header">{groupName}</div>}
                  {groupEntities.map((e) => {
                    const i = filtered.indexOf(e);
                    return (
                      <div
                        key={e.entity_id}
                        id={`${listboxId}-${i}`}
                        ref={el => { itemRefs.current[i] = el; }}
                        className={`entity-picker-item${i === highlighted ? ' highlighted' : ''}`}
                        role="option"
                        aria-selected={i === highlighted}
                        onMouseDown={ev => { ev.preventDefault(); select(e); }}
                        onMouseEnter={() => setHighlighted(i)}
                      >
                        <span className="entity-picker-id">{e.entity_id}</span>
                        {e.friendly_name && e.friendly_name !== e.entity_id && (
                          <span className="entity-picker-name">{e.friendly_name}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
