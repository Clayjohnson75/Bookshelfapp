import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

const VIEWBOX = { width: 24, height: 24 };

type LibraryIconProps = {
 size: number;
 color: string;
};

/**
 * Tab bar icon: 23 books on a shelf (spines + shelf line).
 * Uses stroke/fill so it tints with tabBarActiveTintColor / tabBarInactiveTintColor.
 */
export function LibraryIcon({ size, color }: LibraryIconProps) {
 return (
 <View style={{ width: size, height: size }}>
 <Svg
 width={size}
 height={size}
 viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
 fill="none"
 >
 {/* Shelf line */}
 <Path
 d="M3 18h18"
 stroke={color}
 strokeWidth={1.2}
 strokeLinecap="round"
 />
 {/* Left book spine */}
 <Rect
 x={4}
 y={6}
 width={4}
 height={12}
 rx={0.5}
 fill={color}
 />
 {/* Middle book spine */}
 <Rect
 x={10}
 y={4}
 width={4}
 height={14}
 rx={0.5}
 fill={color}
 />
 {/* Right book spine */}
 <Rect
 x={16}
 y={7}
 width={4}
 height={11}
 rx={0.5}
 fill={color}
 />
 </Svg>
 </View>
 );
}
