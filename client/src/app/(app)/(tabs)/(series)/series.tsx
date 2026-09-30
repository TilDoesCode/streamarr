import { LibraryScreen } from '@/screens/library/library-screen';
import { ShellDesign } from '@/shell/shell-design';

export default function SeriesRoute() {
  return (
    <ShellDesign>
      <LibraryScreen kind="series" />
    </ShellDesign>
  );
}
