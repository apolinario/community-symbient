import { useMemo } from 'react'

const VENUE_INFO = {
  chateau: { name: 'Chateau', icon: '\u{1F3F0}', description: 'Main building rooms' },
  cottage: { name: 'Cottage', icon: '\u{1F3E1}', description: 'Standalone cottages' },
  ferme: { name: 'Farmhouse', icon: '\u{1F33E}', description: 'La Ferme accommodations' },
  gite: { name: 'Gite', icon: '\u{1F3D8}', description: 'Le Gite' },
  glamping: { name: 'Glamping', icon: '\u{26FA}', description: 'Glamping tents' },
  dorm: { name: 'Dorm', icon: '\u{1F6CF}', description: 'Tilleul dormitory bunks' },
  van: { name: 'Van', icon: '\u{1F690}', description: 'Van parking spots' },
  offsite: { name: 'Off-site', icon: '\u{1F4CD}', description: 'Off-site accommodations' },
}

function VenueView({ bookings, rooms, venueFilter, referenceDate }) {
  const today = referenceDate

  // Group rooms by venue
  const venueData = useMemo(() => {
    const data = {}

    rooms.forEach(room => {
      const venue = room.venue
      if (!data[venue]) {
        data[venue] = {
          ...VENUE_INFO[venue],
          rooms: []
        }
      }

      // Find current and next booking for this room
      const roomBookings = bookings
        .filter(b => b.room === room.name)
        .sort((a, b) => a.checkIn.localeCompare(b.checkIn))

      const currentBooking = roomBookings.find(b => {
        const checkIn = new Date(b.checkIn)
        const checkOut = new Date(b.checkOut)
        return checkIn <= today && checkOut > today
      })

      const nextBooking = roomBookings.find(b => {
        const checkIn = new Date(b.checkIn)
        return checkIn > today
      })

      data[venue].rooms.push({
        ...room,
        currentBooking,
        nextBooking,
        isOccupied: !!currentBooking
      })
    })

    return data
  }, [rooms, bookings])

  const formatDate = (dateStr) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const getDaysUntil = (dateStr) => {
    const date = new Date(dateStr)
    const diffMs = date - today
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    return `In ${days} days`
  }

  const venuesToShow = venueFilter === 'all'
    ? Object.keys(venueData)
    : [venueFilter].filter(v => venueData[v])

  return (
    <div className="venue-view">
      {venuesToShow.map(venueKey => {
        const venue = venueData[venueKey]
        if (!venue) return null

        const occupiedCount = venue.rooms.filter(r => r.isOccupied).length
        const totalRooms = venue.rooms.length
        const occupancyPct = totalRooms > 0 ? Math.round((occupiedCount / totalRooms) * 100) : 0

        return (
          <div key={venueKey} className="venue-card">
            <div className="venue-card-header">
              <div className="venue-title">
                <span className="venue-icon">{venue.icon}</span>
                <div>
                  <h3>{venue.name}</h3>
                  <p>{venue.description}</p>
                </div>
              </div>
              <div className="venue-stats">
                <div className="occupancy-ring">
                  <svg viewBox="0 0 36 36">
                    <path
                      className="ring-bg"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    <path
                      className="ring-fill"
                      strokeDasharray={`${occupancyPct}, 100`}
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                  </svg>
                  <span className="occupancy-text">{occupancyPct}%</span>
                </div>
                <div className="occupancy-label">
                  {occupiedCount}/{totalRooms} occupied
                </div>
              </div>
            </div>

            <div className="venue-rooms">
              {venue.rooms.map(room => (
                <div
                  key={room.name}
                  className={`room-card ${room.isOccupied ? 'occupied' : 'vacant'}`}
                >
                  <div className="room-name">
                    {room.name.replace(/Château |Cottage |Ferme |Gîte |Glamping |Dorm /gi, '')}
                  </div>

                  {room.currentBooking ? (
                    <div className="room-booking current">
                      <span className="guest-name">{room.currentBooking.guest}</span>
                      <span className="booking-dates">
                        Until {formatDate(room.currentBooking.checkOut)}
                      </span>
                    </div>
                  ) : room.nextBooking ? (
                    <div className="room-booking upcoming">
                      <span className="guest-name">{room.nextBooking.guest}</span>
                      <span className="booking-dates">
                        {getDaysUntil(room.nextBooking.checkIn)}
                      </span>
                    </div>
                  ) : (
                    <div className="room-booking vacant">
                      <span>Available</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default VenueView
