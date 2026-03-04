import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const VIEWBOX = { width: 24, height: 24 };

type ChevronBackIconProps = {
  size: number;
  color: string;
};

/** Back chevron for headers. Does not depend on icon font. */
export function ChevronBackIcon({ size, color }: ChevronBackIconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <Svg
        width={size}
        height={size}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        fill="none"
      >
        <Path
          d="M15 18l-6-6 6-6"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}
