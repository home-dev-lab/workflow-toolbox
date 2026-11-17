// Claude Code 2.1.325: the render-prop types the What is running pane is checked against.
// Committed input of the render-props schema lock, so that the suite never reads the host's own
// declarations. Derived from a later copy of the host's mods/types/claude-code.d.ts with the props
// added since then removed; the lock proves it parses to the props render-props.snapshot.json pins
// for that version. Types only, comments removed; the aliases below stand in for host types the lock
// does not read. Refresh this file and the snapshot together.
type Color = string;
type Space = number;
type UiPressArgument = unknown;

export type BoxHoverProps = {
  scope?: string;
  borderStyle?: string;
  borderColor?: Color;
  borderDimColor?: boolean;
  backgroundColor?: Color;
  display?: 'flex';
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
};

export type BoxProps = {
  key?: string;
  hover?: BoxHoverProps;
  position?: 'relative' | 'absolute';
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  flexGrow?: number;
  flexShrink?: number;
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  gap?: Space;
  columnGap?: Space;
  rowGap?: Space;
  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  margin?: Space;
  marginX?: Space;
  marginY?: Space;
  marginTop?: Space;
  marginBottom?: Space;
  marginLeft?: Space;
  marginRight?: Space;
  padding?: Space;
  paddingX?: Space;
  paddingY?: Space;
  paddingTop?: Space;
  paddingBottom?: Space;
  paddingLeft?: Space;
  paddingRight?: Space;
  borderStyle?: string;
  borderColor?: Color;
  borderDimColor?: boolean;
  backgroundColor?: Color;
  overflow?: 'visible' | 'hidden';
  display?: 'flex' | 'none';
};

export type ButtonProps = {
  key?: string;
  label?: string;
  hotkey?: string;
  action?: string;
  plain?: true;
  dimColor?: boolean;
  variant?: 'primary' | 'secondary';
  role?: 'dismiss';
  autoFocus?: true;
  hover?: TextHoverProps;
  onPress: (e: UiPressArgument) => void;
};

export type LinkProps = {
  href: string;
  label?: string;
};

export type TextHoverProps = {
  scope?: string;
  color?: Color;
  backgroundColor?: Color;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
};

export type TextProps = {
  hover?: TextHoverProps;
  color?: Color;
  backgroundColor?: Color;
  dimColor?: boolean;
  size?: 'caption' | 'footnote' | 'body' | 'heading' | 'title';
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  mono?: boolean;
  tabular?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  dir?: 'ltr' | 'rtl';
  wrap?: 'wrap' | 'end' | 'middle' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end' | 'clip';
};
