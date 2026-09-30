import { LibraryScreen } from '@/screens/library/library-screen';
import { ShellDesign } from '@/shell/shell-design';

export default function MoviesRoute() {
  return (
    <ShellDesign>
      <LibraryScreen kind="movie" />
    </ShellDesign>
  );
}
