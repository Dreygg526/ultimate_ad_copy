import { redirect } from 'next/navigation';

// Step 1 of the workflow is finding ads, so the Library is the front door.
export default function Home() {
  redirect('/library');
}
