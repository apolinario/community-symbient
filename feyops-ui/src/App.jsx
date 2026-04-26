import { useState, useEffect, useMemo } from 'react'
import './App.css'
import Timeline from './components/Timeline'
import GuestList from './components/GuestList'
import VenueView from './components/VenueView'
import BookingForm from './components/BookingForm'
import PersonMatcher from './components/PersonMatcher'

const API_BASE = window.location.origin + '/api'

function App() {
  const [bookings, setBookings] = useState([])
  const [rooms, setRooms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  const [apiStats, setApiStats] = useState(null)

  const [view, setView] = useState('timeline')
  const [search, setSearch] = useState('')
  const [venueFilter, setVenueFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [editBooking, setEditBooking] = useState(null)
  const [showMatcher, setShowMatcher] = useState(false)

  const [referenceDate, setReferenceDate] = useState(new Date())

  const defaultStart = new Date()
  defaultStart.setDate(defaultStart.getDate() - 3)
  const defaultEnd = new Date()
  defaultEnd.setDate(defaultEnd.getDate() + 28)
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)

  const dateRanges = [
    { label: '2w', days: 14 },
    { label: '3w', days: 21 },
    { label: 'Month', days: 31 },
    { label: '3m', days: 90 },
  ]
  const [activeRange, setActiveRange] = useState(null)

  const visibleDays = useMemo(() => {
    return Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1
  }, [startDate, endDate])

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${API_BASE}/bookings`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const data = await res.json()
      // Normalize field names (API uses checkin/checkout, components use checkIn/checkOut)
      const bookings = Array.isArray(data.bookings) ? data.bookings : []
      const normalized = bookings.map(b => ({
        ...b,
        checkIn: b.checkin,
        checkOut: b.checkout,
      }))
      setBookings(normalized)
      setRooms(data.rooms || [])
      setLastSync(new Date())
      setError(null)

      const statsRes = await fetch(`${API_BASE}/stats`)
      if (statsRes.ok) setApiStats(await statsRes.json())
    } catch (err) {
      console.error('Fetch error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const triggerSync = async () => {
    try {
      setLoading(true)
      await fetch(`${API_BASE}/sync`, { method: 'POST' })
      await fetchData()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleSaveBooking = async (booking) => {
    try {
      const payload = {
        guest: booking.guest,
        room: booking.room,
        checkin: booking.checkin || booking.checkIn,
        checkout: booking.checkout || booking.checkOut,
        plus_one_of: booking.plus_one_of || null,
        notes: booking.notes || '',
        status: booking.status || 'confirmed',
      }
      if (booking.id) {
        await fetch(`${API_BASE}/bookings/${booking.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        await fetch(`${API_BASE}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      setShowForm(false)
      setEditBooking(null)
      await fetchData()
    } catch (err) {
      alert('Save failed: ' + err.message)
    }
  }

  const handleDeleteBooking = async (id) => {
    if (!confirm('Delete this admin booking?')) return
    try {
      const res = await fetch(`${API_BASE}/bookings/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Delete failed')
        return
      }
      await fetchData()
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    }
  }

  const handleEditBooking = (booking) => {
    setEditBooking(booking)
    setShowForm(true)
  }

  const filteredBookings = useMemo(() => {
    return bookings.filter(b => {
      const matchesSearch = !search ||
        b.guest.toLowerCase().includes(search.toLowerCase()) ||
        b.room.toLowerCase().includes(search.toLowerCase())
      const matchesVenue = venueFilter === 'all' || b.venue === venueFilter
      const matchesSource = sourceFilter === 'all' || b.source === sourceFilter
      return matchesSearch && matchesVenue && matchesSource
    })
  }, [bookings, search, venueFilter, sourceFilter])

  const filteredRooms = useMemo(() => {
    return rooms.filter(r => venueFilter === 'all' || r.venue === venueFilter)
  }, [rooms, venueFilter])

  const stats = useMemo(() => {
    const today = referenceDate
    const weekFromNow = new Date(today)
    weekFromNow.setDate(weekFromNow.getDate() + 7)

    const todayGuests = new Set()
    const arrivingGuests = new Set()

    bookings.forEach(b => {
      const checkIn = new Date(b.checkIn)
      const checkOut = new Date(b.checkOut)
      if (checkIn <= today && checkOut > today) todayGuests.add(b.guest)
      if (checkIn > today && checkIn <= weekFromNow) arrivingGuests.add(b.guest)
    })

    const occupiedRooms = new Set(
      bookings.filter(b => {
        const checkIn = new Date(b.checkIn)
        const checkOut = new Date(b.checkOut)
        return checkIn <= today && checkOut > today
      }).map(b => b.room)
    ).size

    return {
      totalGuests: new Set(bookings.map(b => b.guest)).size,
      hereToday: todayGuests.size,
      arrivingThisWeek: arrivingGuests.size,
      occupancy: rooms.length ? Math.round((occupiedRooms / rooms.length) * 100) : 0,
    }
  }, [bookings, rooms, referenceDate])

  const handleRangeSelect = (range) => {
    setActiveRange(range.label)
    const start = new Date(referenceDate)
    start.setDate(start.getDate() - 3)
    const end = new Date(start)
    end.setDate(end.getDate() + range.days - 1)
    setStartDate(start)
    setEndDate(end)
  }

  const shiftDates = (days) => {
    const newStart = new Date(startDate)
    newStart.setDate(newStart.getDate() + days)
    const newEnd = new Date(endDate)
    newEnd.setDate(newEnd.getDate() + days)
    setStartDate(newStart)
    setEndDate(newEnd)
    setActiveRange(null)
  }

  const exportCSV = () => {
    let csv = 'Guest,Room,Venue,Check-in,Check-out,Nights,Source,Notes\n'
    bookings.forEach(b => {
      const nights = Math.ceil((new Date(b.checkOut) - new Date(b.checkIn)) / (1000 * 60 * 60 * 24))
      csv += `"${b.guest}","${b.room}","${b.venue}","${b.checkIn}","${b.checkOut}",${nights},"${b.source}","${b.notes || ''}"\n`
    })
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'feyops-bookings.csv'
    a.click()
  }

  const formatDateInput = (date) => date.toISOString().split('T')[0]

  return (
    <div className="app">
      <header>
        <div className="logo">
          <h1>FeyOps</h1>
          <span className="dates">
            {apiStats ? `${apiStats.amenitiz} Amenitiz + ${apiStats.ooi || 0} Blocked + ${apiStats.admin} Admin` : 'Loading...'}
          </span>
        </div>
        <div className="header-actions">
          <div className="sync-status">
            <span className={`sync-dot ${loading ? 'loading' : ''}`}></span>
            <span>{loading ? 'Syncing...' : (lastSync ? `Synced ${formatTime(lastSync)}` : 'Synced')}</span>
          </div>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn" onClick={exportCSV}>Export CSV</button>
          <button className="btn" onClick={triggerSync}>Sync Amenitiz</button>
          <button className="btn" onClick={() => setShowMatcher(true)}>Match People</button>
          <button className="btn btn-primary" onClick={() => { setEditBooking(null); setShowForm(true) }}>
            + Add Booking
          </button>
        </div>
      </header>

      <div className="stats-row">
        <div className="stat">
          <div className="stat-value">{stats.totalGuests}</div>
          <div className="stat-label">Total Guests</div>
        </div>
        <div className="stat highlight">
          <div className="stat-value">{stats.hereToday}</div>
          <div className="stat-label">Here Today</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.arrivingThisWeek}</div>
          <div className="stat-label">Arriving This Week</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.occupancy}%</div>
          <div className="stat-label">Occupancy</div>
        </div>
        <div className="stat reference-date">
          <label>Reference Date</label>
          <input
            type="date"
            value={formatDateInput(referenceDate)}
            onChange={(e) => setReferenceDate(new Date(e.target.value))}
          />
        </div>
      </div>

      <div className="controls">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search guests or rooms..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="date-controls">
          <div className="date-nav">
            <button className="nav-btn" onClick={() => shiftDates(-7)}>&#8592;</button>
            <div className="date-inputs">
              <input type="date" value={formatDateInput(startDate)} onChange={(e) => { setStartDate(new Date(e.target.value)); setActiveRange(null) }} />
              <span>to</span>
              <input type="date" value={formatDateInput(endDate)} onChange={(e) => { setEndDate(new Date(e.target.value)); setActiveRange(null) }} />
            </div>
            <button className="nav-btn" onClick={() => shiftDates(7)}>&#8594;</button>
          </div>
          <div className="range-selector">
            {dateRanges.map(r => (
              <button key={r.label} className={`range-chip ${activeRange === r.label ? 'active' : ''}`} onClick={() => handleRangeSelect(r)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          {['all', 'chateau', 'cottage', 'ferme', 'gite', 'glamping', 'dorm', 'van', 'offsite'].map(v => {
            const label = v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)
            return (
              <button key={v} className={`filter-chip ${venueFilter === v ? 'active' : ''}`} onClick={() => setVenueFilter(v)}>
                {label}
              </button>
            )
          })}
        </div>

        <div className="source-filter">
          {['all', 'amenitiz', 'ooi', 'admin'].map(s => {
            const labels = { all: 'All Sources', amenitiz: 'Amenitiz', ooi: 'Blocked/OOI', admin: 'Admin' }
            return (
              <button key={s} className={`filter-chip source-chip ${sourceFilter === s ? 'active' : ''}`} onClick={() => setSourceFilter(s)}>
                {labels[s]}
              </button>
            )
          })}
        </div>

        <div className="view-tabs">
          {['timeline', 'guests', 'venues'].map(v => {
            const labels = { timeline: 'Timeline', guests: 'Guest List', venues: 'By Venue' }
            return (
              <button key={v} className={`view-tab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
                {labels[v]}
              </button>
            )
          })}
        </div>
      </div>

      <main>
        {error && (
          <div className="error-banner">
            {error} <button onClick={fetchData}>Retry</button>
          </div>
        )}

        {showMatcher && (
          <PersonMatcher onClose={() => { setShowMatcher(false); fetchData() }} />
        )}

        {showForm && (
          <BookingForm
            booking={editBooking}
            bookings={bookings}
            rooms={rooms}
            onSave={handleSaveBooking}
            onCancel={() => { setShowForm(false); setEditBooking(null) }}
          />
        )}

        {view === 'timeline' && (
          <Timeline bookings={filteredBookings} rooms={filteredRooms} startDate={startDate} visibleDays={visibleDays} referenceDate={referenceDate} />
        )}

        {view === 'guests' && (
          <GuestList bookings={filteredBookings} referenceDate={referenceDate} onEdit={handleEditBooking} onDelete={handleDeleteBooking} />
        )}

        {view === 'venues' && (
          <VenueView bookings={bookings} rooms={filteredRooms} venueFilter={venueFilter} referenceDate={referenceDate} />
        )}
      </main>
    </div>
  )
}

function formatTime(date) {
  const now = new Date()
  const diff = Math.floor((now - date) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  return date.toLocaleTimeString()
}

export default App
