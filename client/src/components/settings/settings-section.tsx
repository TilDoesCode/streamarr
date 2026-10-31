import { Children, Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { colors, useDesign, useFocusGap } from '@/theme';

export type SettingsSectionProps = {
  title: string;
  /** Muted line under the title. */
  description?: string;
  /** Below the card: dialogs and footnotes. */
  footer?: ReactNode;
  /** First block under a page heading (TV scroll anchor). */
  pageTop?: boolean;
  /** No card: the children sit directly under the title (long capability lists). */
  plain?: boolean;
  testID?: string;
  children: ReactNode;
};

/** Titled settings block: an overline title, an optional description and the rows grouped on one card. */
export function SettingsSection({
  title,
  description,
  footer,
  pageTop,
  plain,
  testID,
  children,
}: SettingsSectionProps) {
  const design = useDesign();
  const ringGap = useFocusGap(design.space.sm, 'ring');
  const rows = Children.toArray(children);
  return (
    <FocusSection testID={testID} pageTop={pageTop}>
      <View style={{ gap: plain ? design.space.lg : design.space.md }}>
        <View style={{ gap: design.space.xxs }}>
          <Text variant="overline" tone="subtle">
            {title}
          </Text>
          {description ? (
            <Text variant="callout" tone="muted">
              {description}
            </Text>
          ) : null}
        </View>
        {plain ? (
          children
        ) : (
          <View
            style={{
              padding: design.space.xs,
              borderRadius: design.radius.lg,
              borderCurve: 'continuous',
              backgroundColor: colors.surface.raised,
            }}>
            {rows.map((row, index) => (
              <Fragment key={index}>
                {index > 0 ? (
                  <View
                    style={{
                      height: 1,
                      marginHorizontal: design.space.md,
                      marginVertical: ringGap / 2 - 0.5,
                      backgroundColor: colors.border,
                    }}
                  />
                ) : null}
                {row}
              </Fragment>
            ))}
          </View>
        )}
        {footer}
      </View>
    </FocusSection>
  );
}

/** Padded free content inside a section card (messages, skeletons, hints). */
export function SettingsBlock({ children, testID }: { children: ReactNode; testID?: string }) {
  const design = useDesign();
  return (
    <View testID={testID} style={{ padding: design.space.md, gap: design.space.sm }}>
      {children}
    </View>
  );
}

/** Buttons side by side; on TV the row keeps its place and Left/Right stay inside it. */
export function SettingsButtonRow({ children }: { children: ReactNode }) {
  const design = useDesign();
  const buttonGap = useFocusGap(design.space.md);
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: buttonGap }}>
      {children}
    </FocusGuide>
  );
}
