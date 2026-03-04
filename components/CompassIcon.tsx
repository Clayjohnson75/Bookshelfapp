import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

const VIEWBOX = { width: 24, height: 24 };

type CompassIconProps = {
  size: number;
  color: string;
};

/** Tab bar / header compass icon (outline style). Does not depend on icon font. */
export function CompassIcon({ size, color }: CompassIconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <Svg
        width={size}
        height={size}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        fill="none"
      >
        <Circle
          cx={12}
          cy={12}
          r={10}
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}
