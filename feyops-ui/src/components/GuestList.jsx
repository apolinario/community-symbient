import { useMemo, useState } from 'react'

function GuestList({ bookings, referenceDate, onEdit, onDelete }) {
  const [sortBy, setSortBy] = useState('checkIn')
  const [sortDir, setSortDir] = useState('asc')

  const sortedBookings = useMemo(() => {
    return [...bookings].sort((a, b) => {
      let cmp = 0
      switch (sortBy) {
        case 'guest': cmp = a.guest.localeCompare(b.guest); break
        case 'room': cmp = a.room.localeCompare(b.room); break
        case 'venue': cmp = a.venue.localeCompare(b.venue); break
        case 'checkIn': cmp = a.checkIn.localeCompare(b.checkIn); break
        case 'checkOut': cmp = a.checkOut.localeCompare(b.checkOut); break
        case 'source': cmp = (a.source || '').localeCompare(b.source || ''); break
        case 'nights':
          const nightsA = Math.ceil((new Date(a.checkOut) - new Date(a.checkIn)) / (1000 * 60 * 60 * 24))
          const nightsB = Math.ceil((new Date(b.checkOut) - new Date(b.checkIn)) / (1000 * 60 * 60 * 24))
          cmp = nightsA - nightsB
          break
        default: cmp = 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [bookings, sortBy, sortDir])

  const handleSort = (column) => {
    if (sortBy === column) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(column)
      setSortDir('asc')
    }
  }

  const formatDate = (dateStr) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const getStatus = (booking) => {
    const today = referenceDate
    const checkIn = new Date(booking.checkIn)
    const checkOut = new Date(booking.checkOut)
    if (checkOut <= today) return 'past'
    if (checkIn <= today && checkOut > today) return 'current'
    return 'upcoming'
  }

  const SortIcon = ({ column }) => {
    if (sortBy !== column) return <span className="sort-icon">-</span>
    return <span className="sort-icon">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
  }

  return (
    <div className="guest-list">
      <table>
        <thead>
          <tr>
            <th onClick={() => handleSort('guest')}>Guest <SortIcon column="guest" /></th>
            <th onClick={() => handleSort('room')}>Room <SortIcon column="room" /></th>
            <th onClick={() => handleSort('venue')}>Venue <SortIcon column="venue" /></th>
            <th onClick={() => handleSort('checkIn')}>Check-in <SortIcon column="checkIn" /></th>
            <th onClick={() => handleSort('checkOut')}>Check-out <SortIcon column="checkOut" /></th>
            <th onClick={() => handleSort('nights')}>Nights <SortIcon column="nights" /></th>
            <th onClick={() => handleSort('source')}>Source <SortIcon column="source" /></th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedBookings.map(booking => {
            const nights = Math.ceil(
              (new Date(booking.checkOut) - new Date(booking.checkIn)) / (1000 * 60 * 60 * 24)
            )
            const status = getStatus(booking)

            return (
              <tr key={booking.id} className={`status-${status}`}>
                <td className="guest-name">
                  {booking.guest}
                  {booking.plus_one_of && <span className="plus-one-badge">+1</span>}
                  {booking.person_slug && booking.person_slug !== '__unlinked__' && (
                    <span className="person-badge" title={booking.person_slug}>{booking.person_slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</span>
                  )}
                </td>
                <td>{booking.room}</td>
                <td>
                  <span className={`venue-badge venue-${booking.venue}`}>
                    {booking.venue === 'chateau' ? 'Chateau' : booking.venue === 'gite' ? 'Gite' : booking.venue.charAt(0).toUpperCase() + booking.venue.slice(1)}
                  </span>
                </td>
                <td>{formatDate(booking.checkIn)}</td>
                <td>{formatDate(booking.checkOut)}</td>
                <td className="nights">{nights}</td>
                <td>
                  <span className={`source-badge source-${booking.source}`}>
                    {booking.source === 'amenitiz' ? 'Amenitiz' : booking.source === 'ooi' ? 'Blocked' : 'Admin'}
                  </span>
                </td>
                <td>
                  <span className={`status-badge status-${status}`}>
                    {status === 'current' ? 'Here Now' : status === 'upcoming' ? 'Upcoming' : 'Departed'}
                  </span>
                </td>
                <td className="actions-cell">
                  <button className="action-btn edit-btn" onClick={() => onEdit(booking)} title="Edit">
                    Edit
                  </button>
                  {booking.source === 'admin' && (
                    <button className="action-btn delete-btn" onClick={() => onDelete(booking.id)} title="Delete">
                      Del
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="guest-list-footer">
        Showing {sortedBookings.length} bookings
      </div>
    </div>
  )
}

export default GuestList
