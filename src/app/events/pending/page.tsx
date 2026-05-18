import EventsListPage from '@/components/EventsListPage';
export default function PendingPage() {
  return <EventsListPage status="pending" title="Pending review" emptyMsg="Queue is empty — all events reviewed!"/>;
}
