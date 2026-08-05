import { redirect } from 'next/navigation';
import { defaultProjectId } from '@/lib/projects';

// The bare root carries no project. Redirect to the default project's runs view;
// the switcher (Part E) moves between projects from there. force-dynamic so a
// change to atelier.projects.json is picked up without a rebuild.
export const dynamic = 'force-dynamic';

export default function RootRedirect() {
  redirect(`/${defaultProjectId()}`);
}
