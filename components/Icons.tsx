/**
 * SVG icon components that do not depend on icon fonts.
 * Use these instead of Ionicons to avoid "?" when the font fails to load.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

const VB = 24;

type IconProps = { size: number; color: string; style?: object };

function IconWrap({
  size,
  children,
  style,
}: {
  size: number;
  children: React.ReactNode;
  style?: object;
}) {
  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`} fill="none">
        {children}
      </Svg>
    </View>
  );
}

export function ChevronBackIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ChevronForwardIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ChevronDownIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M6 9l6 6 6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ChevronUpIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M18 15l-6-6-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ArrowBackIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M19 12H5M12 19l-7-7 7-7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ArrowForwardIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M5 12h14M12 5l7 7-7 7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function CloseIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function CloseCircleIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} />
      <Path d="M15 9l-6 6M9 9l6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function CheckmarkIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M20 6L9 17l-5-5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function CheckmarkCircleIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} />
      <Path d="M9 12l3 3 6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function TrashIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M10 11v6M14 11v6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function FolderIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h3.5L12 4.5 15.5 3H20a2 2 0 012 2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function FolderOpenIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h3l2 3h6a2 2 0 012 2v1" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M2 10h20" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function BookOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M6.5 2H20v20H6.5A2.5 2.5 0 004 19.5v-15A2.5 2.5 0 016.5 2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function WarningIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 9v4M12 17h.01" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ImageOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Rect x={3} y={3} width={18} height={18} rx={2} ry={2} stroke={color} strokeWidth={2} />
      <Circle cx={8.5} cy={8.5} r={1.5} stroke={color} strokeWidth={2} />
      <Path d="M21 15l-5-5L5 21" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function FlashIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function AddIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function RemoveIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M5 12h14" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ListOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function SwapHorizontalIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M16 3h5v5M4 20l17-17M8 21H3v-5M21 8v5h-5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function PersonOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={12} cy={7} r={4} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ShareOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Circle cx={18} cy={5} r={3} stroke={color} strokeWidth={2} />
      <Circle cx={6} cy={12} r={3} stroke={color} strokeWidth={2} />
      <Circle cx={18} cy={19} r={3} stroke={color} strokeWidth={2} />
      <Path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function HeartIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill={color} fillOpacity={0.3} />
    </IconWrap>
  );
}

export function SearchIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Circle cx={11} cy={11} r={8} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M21 21l-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function DownloadIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function LibraryOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 7v6M9 10h6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function GlobeOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} />
      <Path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function FingerprintIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M12 11c0-1.1.9-2 2-2s2 .9 2 2v5c0 2.2-1.8 4-4 4s-4-1.8-4-4v-2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 3v2M6.34 5.34l1.42 1.42M3 12h2M17.66 5.34l-1.42 1.42M21 12h-2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function ImagesOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Rect x={2} y={2} width={8} height={8} rx={1} stroke={color} strokeWidth={2} />
      <Rect x={14} y={14} width={8} height={8} rx={1} stroke={color} strokeWidth={2} />
      <Path d="M10 10l4 4M14 10l4 4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </IconWrap>
  );
}

export function CheckboxOutlineIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Rect x={5} y={5} width={14} height={14} rx={2} stroke={color} strokeWidth={2} />
    </IconWrap>
  );
}

export function StarIcon({ size, color, style }: IconProps) {
  return (
    <IconWrap size={size} style={style}>
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill={color} fillOpacity={0.3} />
    </IconWrap>
  );
}
