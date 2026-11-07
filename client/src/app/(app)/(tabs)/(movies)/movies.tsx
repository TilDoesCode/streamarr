import { LibraryScreen } from '@/screens/library/library-screen';
import { LibraryTab, usesLibraryTab } from '@/screens/library/library-tab';
import { ShellDesign } from '@/shell/shell-design';
import { useShell } from '@/shell/use-shell';

/** Movies; on phones the Library tab (Movies | Series). */
export default function MoviesRoute() {
  const { large } = useShell();
  return (
    <ShellDesign>
      {usesLibraryTab(large) ? <LibraryTab /> : <LibraryScreen kind="movie" />}
    </ShellDesign>
  );
}
