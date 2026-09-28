import { z } from 'zod';

const field = z.object({ label: z.string(), value: z.string() });
const section = z.object({
  title: z.string(),
  text: z.string().optional(),
  markdown: z.string().optional(),
  code: z.string().max(256).optional(),
  actions: z.array(z.number().int().min(0).max(11)).max(2).optional(),
  fields: z.array(field).max(12).optional(),
  notes: z.array(z.string()).max(8).optional(),
  meters: z
    .array(
      z.object({ label: z.string(), remaining: z.number().min(0).max(100), reset: z.string() }),
    )
    .max(2)
    .optional(),
  approval: z.boolean().optional(),
});
/** Presentation only. Routing and callback authority still come from persisted actions. */
export const cardLayoutSchema = z.object({
  version: z.literal(1),
  eyebrow: z.string(),
  heading: z.string(),
  status: z.string().optional(),
  theme: z.enum(['blue', 'green', 'red', 'orange', 'grey']).default('blue'),
  alerts: z.array(z.string()).max(8).default([]),
  sections: z.array(section).max(12).default([]),
  notes: z.array(z.string()).max(8).default([]),
});
export type CardLayout = z.infer<typeof cardLayoutSchema>;
export type CardSection = z.infer<typeof section>;
export const escapeCardText = (text: string) => text.replace(/[\\`*_\[\]<>~]/g, '\\$&');
export const cardTime = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const markdown = (content: string) => ({ tag: 'markdown', content });
const muted = (text: string) => markdown(`<font color='grey'>${escapeCardText(text)}</font>`);

export function buttonRows(buttons: object[]) {
  return Array.from({ length: Math.ceil(buttons.length / 2) }, (_, i) => ({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'medium',
    columns: buttons.slice(i * 2, i * 2 + 2),
  }));
}
export function renderLayout(
  layout: CardLayout,
  approvalButtons: object[] = [],
  buttons: object[] = [],
): object[] {
  const elements: object[] = [
    muted(layout.eyebrow),
    { tag: 'markdown', content: `**${escapeCardText(layout.heading)}**`, text_size: 'heading' },
    ...(layout.status ? [markdown(`**${escapeCardText(layout.status)}**`)] : []),
    ...layout.alerts.map((text) => markdown(`**需要留意**\n${escapeCardText(text)}`)),
  ];
  for (const section of layout.sections) {
    elements.push({ tag: 'hr' }, markdown(`**${escapeCardText(section.title)}**`));
    if (section.fields) {
      for (let i = 0; i < section.fields.length; i += 2) {
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: 'large',
          columns: section.fields.slice(i, i + 2).map((f) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [muted(f.label), markdown(`**${escapeCardText(f.value)}**`)],
          })),
        });
      }
    }
    if (section.text) elements.push(markdown(escapeCardText(section.text)));
    if (section.markdown) elements.push(markdown(section.markdown));
    if (section.code)
      elements.push(markdown('```\n' + section.code.replace(/`/g, '\u02cb') + '\n```'));
    for (const meter of section.meters ?? []) {
      const filled = Math.round(meter.remaining / 10);
      elements.push(
        markdown(
          `${escapeCardText(meter.label)} · **剩余 ${Math.round(meter.remaining * 10) / 10}%**\n${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`,
        ),
        muted(meter.reset),
      );
    }
    elements.push(...(section.notes ?? []).map(muted));
    if (section.approval) elements.push(...buttonRows(approvalButtons));
    if (section.actions)
      elements.push(
        ...buttonRows(section.actions.map((i) => buttons[i]).filter((b): b is object => !!b)),
      );
  }
  if (layout.notes.length) elements.push({ tag: 'hr' }, ...layout.notes.map(muted));
  return elements;
}

export function buttonStyle(action: string, choice?: string | null) {
  if (action === 'interrupt' || action === 'cancel_draft' || action === 'cancel_project')
    return 'danger';
  // Approval choices deliberately have equal visual weight; no implied default authorization.
  if (action === 'approval') return 'default';
  if (action === 'details' || action === 'select' || (action === 'panel' && choice === 'details'))
    return 'primary';
  if (action === 'projects' || action === 'refresh' || (action === 'panel' && choice === 'refresh'))
    return 'default';
  return 'default';
}
