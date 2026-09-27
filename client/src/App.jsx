import { BrowserRouter, Routes, Route, Link, useParams } from 'react-router-dom';
import { Dashboard,DetailsPage } from './pages/Dashboard.jsx';
import SearchPage from './pages/Search.jsx';

function DetailsRoute() {
  const { id } = useParams();
  return <DetailsPage trackedId={id} />;
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <header className="nav">
        <Link className="logo" to="/">INE Price Tracker</Link>
        <nav>
          <Link to="/">Dashboard</Link>
          <Link to="/search">Search</Link>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/tracked/:id" element={<DetailsRoute />} />
        </Routes>
      </main>
      <footer className="foot">Scrapes demo.inelabteamdev.com every 2 hour · honest logs, no fake history</footer>
    </BrowserRouter>
  );
}
