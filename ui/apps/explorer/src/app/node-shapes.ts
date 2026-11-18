/** One outline per kind of entity, so a graph can be read at a glance. */
export type NodeShape =
  | 'rounded' | 'cylinder' | 'stack' | 'parallelogram' | 'hexagon' | 'browser'
  | 'component' | 'folder' | 'stadium' | 'octagon' | 'note' | 'rect';

export interface ShapeDrawing {
  /** Drawn first, behind the outline (the back cards of a stack). */
  behind: string[];
  /** The filled and stroked outline. */
  outline: string;
  /** Extra strokes on top (a cylinder's rim, a browser's title bar). */
  details: string[];
  /** Where the text sits relative to the vertical centre. */
  textOffsetY: number;
}

export const SHAPE_LEGEND: { shape: NodeShape; label: string }[] = [
  { shape: 'rounded', label: 'Thing' },
  { shape: 'cylinder', label: 'Data table, stream, persistence provider' },
  { shape: 'stack', label: 'Thing template' },
  { shape: 'parallelogram', label: 'Thing shape' },
  { shape: 'hexagon', label: 'Data shape' },
  { shape: 'browser', label: 'Mashup' },
  { shape: 'component', label: 'Widget' },
  { shape: 'folder', label: 'Project or extension' },
  { shape: 'stadium', label: 'User, group, role, organisation' },
  { shape: 'octagon', label: 'Resource or subsystem' },
  { shape: 'note', label: 'Style, state, media, localisation, vocabulary, menu' },
  { shape: 'rect', label: 'Other' },
];

const BY_TYPE: Record<string, NodeShape> = {
  Thing: 'rounded', Things: 'rounded',
  ThingTemplate: 'stack', ThingTemplates: 'stack',
  ThingShape: 'parallelogram', ThingShapes: 'parallelogram',
  DataShape: 'hexagon', DataShapes: 'hexagon',
  Mashup: 'browser', Mashups: 'browser', Dashboard: 'browser', MashupTemplate: 'browser',
  Widget: 'component', Widgets: 'component',
  Project: 'folder', Projects: 'folder', ExtensionPackage: 'folder', Extension: 'folder',
  User: 'stadium', Users: 'stadium', Group: 'stadium', Groups: 'stadium', Organization: 'stadium', Organizations: 'stadium',
  Role: 'stadium', PermissionGroup: 'stadium', ApplicationKey: 'stadium',
  Resource: 'octagon', Resources: 'octagon', Subsystem: 'octagon', Subsystems: 'octagon', Authenticator: 'octagon',
  PersistenceProvider: 'cylinder', DataTable: 'cylinder', Stream: 'cylinder', ValueStream: 'cylinder',
  StyleDefinition: 'note', StateDefinition: 'note', StyleTheme: 'note', MediaEntity: 'note', LocalizationTable: 'note',
  ModelTagVocabulary: 'note', DataTagVocabulary: 'note', Menu: 'note', Network: 'note',
};

/** The shape for an entity type ("ThingTemplate") or collection ("ThingTemplates"). A data-holding Thing is a cylinder. */
export function shapeForType(type: string, isDataThing = false): NodeShape {
  if (isDataThing && (type === 'Thing' || type === 'Things')) return 'cylinder';
  return BY_TYPE[type] ?? 'rect';
}

/** Room a slanted or pointed outline needs beside the text. */
export function shapeExtraWidth(shape: NodeShape): number {
  return shape === 'hexagon' || shape === 'parallelogram' || shape === 'octagon' ? 24 : shape === 'component' || shape === 'stack' ? 10 : 0;
}

export function drawShape(shape: NodeShape, width: number, height: number): ShapeDrawing {
  const right = width;
  const bottom = height;
  const plain = (outline: string, details: string[] = [], textOffsetY = 0): ShapeDrawing => ({ behind: [], outline, details, textOffsetY });
  switch (shape) {
    case 'rounded':
      return plain(roundedRect(0, 0, right, bottom, 8));
    case 'stadium':
      return plain(roundedRect(0, 0, right, bottom, bottom / 2));
    case 'cylinder': {
      const rim = Math.min(7, bottom / 5);
      const half = right / 2;
      return plain(
        `M0,${rim} A${half},${rim} 0 0 1 ${right},${rim} V${bottom - rim} A${half},${rim} 0 0 1 0,${bottom - rim} Z`,
        [`M0,${rim} A${half},${rim} 0 0 0 ${right},${rim}`],
        rim / 2,
      );
    }
    case 'stack': {
      const step = 4;
      return {
        behind: [rectPath(step * 2, 0, right, bottom - step * 2), rectPath(step, step, right - step, bottom - step)],
        outline: rectPath(0, step * 2, right - step * 2, bottom),
        details: [],
        textOffsetY: step,
      };
    }
    case 'parallelogram': {
      const slant = 10;
      return plain(`M${slant},0 H${right} L${right - slant},${bottom} H0 Z`);
    }
    case 'hexagon': {
      const point = 12;
      return plain(`M${point},0 H${right - point} L${right},${bottom / 2} L${right - point},${bottom} H${point} L0,${bottom / 2} Z`);
    }
    case 'octagon': {
      const corner = Math.min(9, bottom / 3);
      return plain(`M${corner},0 H${right - corner} L${right},${corner} V${bottom - corner} L${right - corner},${bottom} H${corner} L0,${bottom - corner} V${corner} Z`);
    }
    case 'browser': {
      const bar = 9;
      const dots = [6, 12, 18].map((x) => `M${x - 1.6},${bar / 2} a1.6,1.6 0 1 0 3.2,0 a1.6,1.6 0 1 0 -3.2,0`);
      return plain(roundedRect(0, 0, right, bottom, 4), [`M0,${bar} H${right}`, ...dots], bar / 2);
    }
    case 'component': {
      const tab = 8;
      return plain(rectPath(tab, 0, right, bottom), [rectPath(0, bottom * 0.22, tab * 2, bottom * 0.22 + 7), rectPath(0, bottom * 0.62, tab * 2, bottom * 0.62 + 7)]);
    }
    case 'folder': {
      const tabWidth = Math.min(40, right * 0.4);
      return plain(`M0,0 H${tabWidth} L${tabWidth + 6},6 H${right} V${bottom} H0 Z`, [`M0,6 H${tabWidth + 6}`], 3);
    }
    case 'note': {
      const fold = 10;
      return plain(`M0,0 H${right - fold} L${right},${fold} V${bottom} H0 Z`, [`M${right - fold},0 V${fold} H${right}`]);
    }
    default:
      return plain(rectPath(0, 0, right, bottom));
  }
}

function rectPath(left: number, top: number, right: number, bottom: number): string {
  return `M${left},${top} H${right} V${bottom} H${left} Z`;
}

function roundedRect(left: number, top: number, right: number, bottom: number, radius: number): string {
  const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  return `M${left + r},${top} H${right - r} A${r},${r} 0 0 1 ${right},${top + r} V${bottom - r} A${r},${r} 0 0 1 ${right - r},${bottom} `
    + `H${left + r} A${r},${r} 0 0 1 ${left},${bottom - r} V${top + r} A${r},${r} 0 0 1 ${left + r},${top} Z`;
}
