import { History, Search } from '@/components/icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { colors, useDesign } from '@/theme';

import { GalleryRow, GallerySection } from './gallery-section';

function StateFrame({ children }: { children: ReactNode }) {
  const design = useDesign();
  return (
    <View
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'center' : undefined}
      style={{
        flexGrow: 1,
        // TV: one state per line; action rows stop at their right end, so a grid would strand cells.
        flexBasis: design.isTV ? '100%' : design.px(300),
        borderRadius: design.radius.lg,
        backgroundColor: colors.surface.DEFAULT,
      }}>
      {children}
    </View>
  );
}

export function GalleryStates({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <GallerySection title={t('gallery.sections.states')} testID="section-states">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.lg }}>
        <StateFrame>
          <EmptyState
            icon={History}
            title={t('states.emptyContinue.title')}
            message={t('states.emptyContinue.message')}
            actions={
              <Button
                label={t('common.search')}
                icon={Search}
                variant="secondary"
                onPress={() => onAction(t('common.search'))}
              />
            }
          />
        </StateFrame>
        <StateFrame>
          <EmptyState
            icon={Search}
            title={t('states.emptySearch.title', { query: 'Sintle' })}
            message={t('states.emptySearch.message')}
          />
        </StateFrame>
        <StateFrame>
          <ErrorState
            testID="error-network"
            code="network_unreachable"
            actions={['retry']}
            onAction={(action) => onAction(t(`errors.actions.${action}`))}
          />
        </StateFrame>
        <StateFrame>
          <ErrorState
            code="age_restricted"
            actions={['goHome', 'back']}
            onAction={(action) => onAction(t(`errors.actions.${action}`))}
          />
        </StateFrame>
        <StateFrame>
          <ErrorState
            testID="error-unknown"
            code="release_exploded"
            actions={['retry', 'otherVersion', 'useVlc']}
            onAction={(action) => onAction(t(`errors.actions.${action}`))}
          />
        </StateFrame>
      </View>
    </GallerySection>
  );
}

type AudioTrack = 'original' | 'dub' | 'commentary';

// Longer than a TV screen: exercises the Sheet's scrolling.
const SUBTITLE_TRACKS = Array.from({ length: 15 }, (_, index) => index + 1);

export function GalleryOverlays({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [longSheetOpen, setLongSheetOpen] = useState(false);
  const [audio, setAudio] = useState<AudioTrack>('original');
  const [subtitle, setSubtitle] = useState(0);
  const subtitleLabel = (track: number) =>
    track === 0 ? t('gallery.longSheet.off') : t('gallery.longSheet.track', { number: track });
  return (
    <GallerySection title={t('gallery.sections.overlays')} testID="section-overlays">
      <GalleryRow>
        <Button
          testID="open-dialog"
          label={t('gallery.dialog.open')}
          variant="secondary"
          onPress={() => setDialogOpen(true)}
        />
        <Button
          testID="open-sheet"
          label={t('gallery.sheet.open')}
          variant="secondary"
          onPress={() => setSheetOpen(true)}
        />
        <Button
          testID="open-long-sheet"
          label={t('gallery.longSheet.open')}
          variant="secondary"
          onPress={() => setLongSheetOpen(true)}
        />
      </GalleryRow>
      {/* Own row: six buttons wrap on a German TV screen, and right at a wrapped line end jumps diagonally. */}
      <GalleryRow>
        <Button
          testID="toast-info"
          label={t('gallery.toast.info')}
          variant="secondary"
          onPress={() => toast.show({ message: t('gallery.toast.infoMessage'), tone: 'info' })}
        />
        <Button
          testID="toast-success"
          label={t('gallery.toast.success')}
          variant="secondary"
          onPress={() =>
            toast.show({ message: t('gallery.toast.successMessage'), tone: 'success' })
          }
        />
        <Button
          testID="toast-error"
          label={t('gallery.toast.error')}
          variant="secondary"
          onPress={() => toast.show({ message: t('gallery.toast.errorMessage'), tone: 'error' })}
        />
      </GalleryRow>
      <Dialog
        testID="dialog"
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t('gallery.dialog.title')}
        message={t('gallery.dialog.message')}
        actions={[
          { label: t('common.cancel'), onPress: () => setDialogOpen(false) },
          {
            label: t('gallery.dialog.confirm'),
            variant: 'destructive',
            onPress: () => {
              setDialogOpen(false);
              onAction(t('gallery.dialog.confirm'));
            },
          },
        ]}
      />
      <Sheet
        testID="sheet"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t('gallery.sheet.title')}>
        {(['original', 'dub', 'commentary'] as const).map((track) => (
          <SheetItem
            key={track}
            label={t(`gallery.sheet.options.${track}`)}
            selected={audio === track}
            preferred={audio === track}
            onPress={() => {
              setAudio(track);
              setSheetOpen(false);
              onAction(t(`gallery.sheet.options.${track}`));
            }}
          />
        ))}
      </Sheet>
      <Sheet
        testID="long-sheet"
        open={longSheetOpen}
        onClose={() => setLongSheetOpen(false)}
        title={t('gallery.longSheet.title')}>
        {[0, ...SUBTITLE_TRACKS].map((track) => (
          <SheetItem
            key={track}
            label={subtitleLabel(track)}
            selected={subtitle === track}
            preferred={subtitle === track}
            onPress={() => {
              setSubtitle(track);
              setLongSheetOpen(false);
              onAction(subtitleLabel(track));
            }}
          />
        ))}
      </Sheet>
    </GallerySection>
  );
}
