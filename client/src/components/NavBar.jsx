import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Home, Search, Layers, History, LogOut, Leaf, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const tabs = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/library', label: 'Pipeline', icon: Layers },
  { to: '/history', label: 'History', icon: History },
];

export default function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <header className={`topnav ${solid ? 'solid' : ''}`}>
        <NavLink to="/" className="brand">
          <span className="leaf"><Leaf size={22} /></span>
          Heiken
        </NavLink>
        <nav className="nav-links">
          {tabs.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-right">
          <button className="icon-btn" title="Admin (tickets)" onClick={() => navigate('/admin')} style={{ width: 34, height: 34 }}>
            <ShieldCheck size={16} />
          </button>
          <div className="nav-user" title={`Ticket expires: ${user?.ticketExpiresAt ? new Date(user.ticketExpiresAt).toLocaleDateString() : 'never'}`}>
            <span className="nav-avatar">{(user?.label || 'U')[0]}</span>
            <span>{user?.label || 'User'}</span>
          </div>
          <button className="icon-btn" title="Sign out" onClick={logout} style={{ width: 34, height: 34 }}>
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <nav className="bottomnav">
        {tabs.map(({ to, label, icon: Icon, end }) => ( // eslint-disable-line no-unused-vars
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <Icon /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
