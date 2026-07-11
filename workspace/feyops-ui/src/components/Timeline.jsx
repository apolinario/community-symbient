import { useMemo, useRef, useEffect } from 'react'

const VENUE_COLORS = {
  chateau: '#8B4513',
  cottage: '#228B22',
  ferme: '#DAA520',
  gite: '#4169E1',
  glamping: '#9370DB',
  dorm: '#708090',
  van: '#2d6a4f',
  offsite: '#a3a3a3',
}

function Timeline({ bookings, rooms, startDate, visibleDays, referenceDate }) {
  const scrollRef = useRef(null)

  // Generate date headers
  const dates = useMemo(() => {
    const result = []
    for (let i = 0; i < visibleDays; i++) {
      const date = new Date(startDate)
      date.setDate(date.getDate() + i)
      result.push(date)
    }
    return result
  }, [startDate, visibleDays])

  // Group rooms by venue
  const groupedRooms = useMemo(() => {
    const groups = {}
    const venueOrder = ['chateau', 'cottage', 'ferme', 'gite', 'glamping', 'dorm', 'van', 'offsite']
    rooms.forEach(room => {
      if (!groups[room.venue]) {
        groups[room.venue] = []
      }
      groups[room.venue].push(room)
    })
    // Sort by venue order
    const sorted = {}
    venueOrder.forEach(v => {
      if (groups[v]) sorted[v] = groups[v]
    })
    return sorted
  }, [rooms])

  // Get bookings for a specific room
  const getBookingsForRoom = (roomName) => {
    return bookings.filter(b => b.room === roomName)
  }

  // Check if a cell is free (no booking)
  const isCellFree = (roomName, date) => {
    const dateStr = date.toISOString().split('T')[0]
    const roomBookings = bookings.filter(b => b.room === roomName)
    return !roomBookings.some(b => {
      const checkIn = b.checkIn
      const checkOut = b.checkOut
      return dateStr >= checkIn && dateStr < checkOut
    })
  }

  // Calculate booking bar position and width
  const getBookingStyle = (booking) => {
    const checkIn = new Date(booking.checkIn)
    const checkOut = new Date(booking.checkOut)
    const viewStart = new Date(startDate)
    const viewEnd = new Date(startDate)
    viewEnd.setDate(viewEnd.getDate() + visibleDays)

    const barStart = Math.max(checkIn, viewStart)
    const barEnd = Math.min(checkOut, viewEnd)

    if (barStart >= barEnd) return null

    const startOffset = Math.floor((barStart - viewStart) / (1000 * 60 * 60 * 24))
    const duration = Math.ceil((barEnd - barStart) / (1000 * 60 * 60 * 24))

    const dayWidth = 100 / visibleDays

    return {
      left: `${startOffset * dayWidth}%`,
      width: `${duration * dayWidth}%`,
      backgroundColor: VENUE_COLORS[booking.venue] || '#666'
    }
  }

  const formatDateHeader = (date) => {
    const day = date.getDate()
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' })
    const month = date.toLocaleDateString('en-US', { month: 'short' })
    const isFirst = day === 1
    return { day, weekday, month, isFirst }
  }

  const isToday = (date) => {
    return date.toDateString() === referenceDate.toDateString()
  }

  const isWeekend = (date) => {
    const day = date.getDay()
    return day === 0 || day === 6
  }

  const isMonday = (date) => date.getDay() === 1  // Canonical arrival day
  const isSunday = (date) => date.getDay() === 0  // Canonical departure day

  // Calculate cell width based on visible days
  let cellWidth = 32
  if (visibleDays > 60) cellWidth = 18
  else if (visibleDays > 30) cellWidth = 24

  return (
    <div className="timeline">
      <div className="timeline-scroll-container" ref={scrollRef}>
        <div className="timeline-inner" style={{ minWidth: `${cellWidth * visibleDays + 160}px` }}>
          {/* Date header */}
          <div className="timeline-header">
            <div className="timeline-room-label">Room</div>
            <div className="timeline-dates">
              {dates.map((date, i) => {
                const { day, weekday, month, isFirst } = formatDateHeader(date)
                return (
                  <div
                    key={i}
                    className={`timeline-date ${isToday(date) ? 'today' : ''} ${isWeekend(date) ? 'weekend' : ''} ${isFirst ? 'month-start' : ''} ${isMonday(date) ? 'arrival-day' : ''} ${isSunday(date) ? 'departure-day' : ''}`}
                    style={{ width: cellWidth }}
                  >
                    {isFirst && <span className="month-label">{month}</span>}
                    <span className="weekday">{weekday.charAt(0)}</span>
                    <span className="day">{day}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Room rows grouped by venue */}
          <div className="timeline-body">
            {Object.entries(groupedRooms).map(([venue, venueRooms]) => (
              <div key={venue} className="venue-group">
                <div className={`venue-header venue-${venue}`}>
                  {venue.charAt(0).toUpperCase() + venue.slice(1)}
                  <span className="venue-count">({venueRooms.length})</span>
                </div>
                {venueRooms.map(room => {
                  const roomBookings = getBookingsForRoom(room.name)
                  return (
                    <div key={room.name} className="timeline-row">
                      <div className="timeline-room-label" title={room.name}>
                        {room.name
                          .replace(/\(Le Château\)|\(Le Chateau\)|\(Le Cottage\)|\(La Ferme\)/gi, '')
                          .replace(/Tilleul /gi, '')
                          .trim()}
                      </div>
                      <div className="timeline-cells">
                        {dates.map((date, i) => {
                          const free = isCellFree(room.name, date)
                          return (
                            <div
                              key={i}
                              className={`timeline-cell ${isToday(date) ? 'today' : ''} ${isWeekend(date) ? 'weekend' : ''} ${free ? 'free' : ''} ${isMonday(date) ? 'arrival-day' : ''} ${isSunday(date) ? 'departure-day' : ''}`}
                              style={{ width: cellWidth }}
                              title={free ? `${room.name} - Available` : ''}
                            />
                          )
                        })}
                        {roomBookings.map(booking => {
                          const style = getBookingStyle(booking)
                          if (!style) return null
                          return (
                            <div
                              key={booking.id}
                              className="booking-bar"
                              style={style}
                              title={`${booking.guest}\n${booking.checkIn} to ${booking.checkOut}`}
                            >
                              <span className="booking-guest">{booking.guest}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="timeline-legend">
        <div className="legend-item">
          <span className="legend-color free-indicator" />
          <span className="legend-label">Available</span>
        </div>
        <div className="legend-item">
          <span className="legend-color arrival-indicator" />
          <span className="legend-label">Mon (Arrival)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color departure-indicator" />
          <span className="legend-label">Sun (Departure)</span>
        </div>
        {Object.keys(VENUE_COLORS).map((venue) => (
          <div key={venue} className="legend-item">
            <span className={`legend-color venue-${venue}-bg`} />
            <span className="legend-label">
              {venue.charAt(0).toUpperCase() + venue.slice(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Timeline
