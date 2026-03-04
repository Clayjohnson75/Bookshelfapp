import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const VIEWBOX = { width: 24, height: 24 };

type CameraIconProps = {
  size: number;
  color: string;
};

/** Tab bar / header camera icon (outline style). Does not depend on icon font. */
export function CameraIcon({ size, color }: CameraIconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <Svg
        width={size}
        height={size}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        fill="none"
      >
        <Path
          d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M12 17a4 4 0 100-8 4 4 0 000 8z"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}
