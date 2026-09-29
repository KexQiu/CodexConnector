// One 24 px grid and stroke weight for navigation, controls, and feedback.
const paths = {
  overview:
    'M5 3.5h4A1.5 1.5 0 0 1 10.5 5v4A1.5 1.5 0 0 1 9 10.5H5A1.5 1.5 0 0 1 3.5 9V5A1.5 1.5 0 0 1 5 3.5Z M15 3.5h4A1.5 1.5 0 0 1 20.5 5v4A1.5 1.5 0 0 1 19 10.5h-4A1.5 1.5 0 0 1 13.5 9V5A1.5 1.5 0 0 1 15 3.5Z M5 13.5h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9 20.5H5A1.5 1.5 0 0 1 3.5 19v-4A1.5 1.5 0 0 1 5 13.5Z M15 13.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5Z',
  feishu:
    'M8 4h8a5 5 0 0 1 5 5v3a5 5 0 0 1-5 5h-5l-6 4v-5a5 5 0 0 1-2-4V9a5 5 0 0 1 5-5Z M7.5 9h9 M7.5 12.5h5',
  projects:
    'M3.5 8.5v-3A1.5 1.5 0 0 1 5 4h4l3 3h7A1.5 1.5 0 0 1 20.5 8.5v10A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-10h17',
  logs: 'M13.5 3.5H6A1.5 1.5 0 0 0 4.5 5v14A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5V9.5l-6-6Z M13.5 3.5V8A1.5 1.5 0 0 0 15 9.5h4.5 M8.5 13h7 M8.5 16.5h5',
  setup:
    'M14.5 4.5 19.5 9.5 M4 20l3.5-1 13-13a1.4 1.4 0 0 0 0-2l-.5-.5a1.4 1.4 0 0 0-2 0l-13 13L4 20Z M5 3v4 M3 5h4 M19 15v6 M16 18h6',
  preferences:
    'M4 7h4 M13 7h7 M4 17h9 M18 17h2 M10.5 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M15.5 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  arrow: 'M4.5 12h15 M14 6.5l5.5 5.5-5.5 5.5',
  plus: 'M12 5v14 M5 12h14',
  refresh: 'M20 9a8 8 0 0 0-13.5-4L3 8 M3 3v5h5 M4 15a8 8 0 0 0 13.5 4l3.5-3 M21 21v-5h-5',
  power: 'M12 3v8 M6.5 5.5a8.5 8.5 0 1 0 11 0',
  stop: 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
  check: 'm5.5 12 4 4 9-9',
  shield: 'M12 3 4.5 6v5.5c0 4 3 7 7.5 9.5 4.5-2.5 7.5-5.5 7.5-9.5V6L12 3Z m-4 9 2.5 2.5 5-5',
  terminal:
    'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5Z m2 4.5 3 3-3 3 M13 15h4',
  laptop:
    'M5 16V5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5V16 M3 16h18v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2Z M10 17h4',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  chevron: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  close: 'm7 7 10 10 M17 7 7 17',
  success: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z m-13-0.5 3 3 5-5',
  alert: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 7.5v5 M12 16h.01',
} as const;

export function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function ConnectorMark() {
  return <img className="connector-mark" src="./connector-mark.svg" alt="" draggable={false} />;
}
