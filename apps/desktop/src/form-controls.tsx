import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import type { CSSProperties, InputHTMLAttributes, KeyboardEvent } from 'react';

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`text-input ${className}`} />;
}

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

/** A select-only combobox: focus stays on the trigger while navigating options. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  className = '',
  disabled = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);
  const expanded = open && !disabled;

  function show(edge?: 'first' | 'last') {
    const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
    if (disabled || !enabled.length) return;
    const current = options.findIndex((option) => option.value === value && !option.disabled);
    setHighlighted(
      edge === 'last' ? enabled.at(-1)! : edge === 'first' || current < 0 ? enabled[0]! : current,
    );
    search.current = { text: '', time: 0 };
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event;
    if (key === 'Tab') {
      setOpen(false);
      return;
    }
    if (key === 'Escape') {
      if (expanded) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault();
      if (!expanded) {
        show(key === 'Home' ? 'first' : key === 'End' ? 'last' : undefined);
      } else if (key === 'Enter' || key === ' ') {
        choose(highlighted);
      } else {
        const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
        const current = enabled.indexOf(highlighted);
        const next =
          key === 'Home'
            ? 0
            : key === 'End'
              ? enabled.length - 1
              : current + (key === 'ArrowDown' ? 1 : -1);
        setHighlighted(enabled[Math.max(0, Math.min(next, enabled.length - 1))] ?? 0);
      }
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - search.current.time < 700 ? search.current.text : '') + key.toLowerCase();
      search.current = { text, time: now };
      const index = options.findIndex(
        (option) => !option.disabled && option.label.toLowerCase().startsWith(text),
      );
      if (index >= 0) {
        setHighlighted(index);
        setOpen(true);
      }
    }
  }

  useLayoutEffect(() => {
    if (!expanded || !trigger.current || !list.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const gap = 8;
    const below = window.innerHeight - bounds.bottom - gap * 2;
    const above = bounds.top - gap * 2;
    const upwards = below < Math.min(list.current.scrollHeight, 320) && above > below;
    const width = Math.min(Math.max(bounds.width, 280), window.innerWidth - gap * 2);
    setPosition({
      width,
      left: Math.max(gap, Math.min(bounds.left, window.innerWidth - width - gap)),
      maxHeight: Math.max(0, Math.min(320, upwards ? above : below)),
      ...(upwards
        ? { bottom: window.innerHeight - bounds.top + gap }
        : { top: bounds.bottom + gap }),
    });
  }, [expanded, options.length]);

  useLayoutEffect(() => {
    const popup = list.current;
    const option = popup?.children[highlighted] as HTMLElement | undefined;
    if (!expanded || !popup || !option) return;
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight)
      popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
  }, [expanded, highlighted, position]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !list.current?.contains(event.target)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [expanded]);

  return (
    <div className={`field select-field ${className}`} ref={root}>
      <label htmlFor={id} id={`${id}-label`}>
        {label}
      </label>
      <button
        id={id}
        ref={trigger}
        type="button"
        role="combobox"
        className="select-trigger"
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded ? `${id}-option-${highlighted}` : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        onClick={() => (expanded ? setOpen(false) : show())}
      >
        <span className="select-value">{selected?.label ?? '请选择'}</span>
        <Icon name="chevronDown" className="select-chevron" />
      </button>
      {expanded && (
        <div
          id={`${id}-list`}
          ref={list}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="select-popup"
          style={position}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <div
              id={`${id}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={value === option.value}
              aria-disabled={option.disabled || undefined}
              className={`select-option ${highlighted === index ? 'highlighted' : ''}`}
              onPointerMove={() => {
                if (!option.disabled) setHighlighted(index);
              }}
              onClick={() => choose(index)}
            >
              <span>
                <span className="select-option-label">{option.label}</span>
                {option.description && (
                  <span className="select-option-description">{option.description}</span>
                )}
              </span>
              {value === option.value && <Icon name="check" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
