import { useState } from 'react'

function BookingForm({ booking, bookings, rooms, onSave, onCancel }) {
  const isEdit = !!booking?.id

  const [form, setForm] = useState({
    guest: booking?.guest || '',
    room: booking?.room || '',
    checkin: booking?.checkIn || booking?.checkin || '',
    checkout: booking?.checkOut || booking?.checkout || '',
    plus_one_of: booking?.plus_one_of || '',
    notes: booking?.notes || '',
    status: booking?.status || 'confirmed',
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    onSave({
      ...(isEdit ? { id: booking.id } : {}),
      ...form,
      plus_one_of: form.plus_one_of ? Number(form.plus_one_of) : null,
    })
  }

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }))

  // Unique room names for the datalist
  const roomNames = [...new Set(rooms.map(r => r.name))]

  // Unique guests for +1 reference
  const mainGuests = bookings
    .filter(b => !b.plus_one_of)
    .reduce((acc, b) => {
      if (!acc.find(x => x.id === b.id)) acc.push(b)
      return acc
    }, [])

  return (
    <div className="booking-form-overlay">
      <form className="booking-form" onSubmit={handleSubmit}>
        <h3>{isEdit ? 'Edit Booking' : 'Add Admin Booking'}</h3>
        {isEdit && booking?.source === 'amenitiz' && (
          <div className="form-notice">
            This is an Amenitiz booking. Changes here will be overwritten on next sync (except notes).
          </div>
        )}

        <div className="form-grid">
          <div className="form-field">
            <label>Guest Name *</label>
            <input type="text" value={form.guest} onChange={(e) => update('guest', e.target.value)} required />
          </div>

          <div className="form-field">
            <label>Room *</label>
            <input type="text" list="room-list" value={form.room} onChange={(e) => update('room', e.target.value)} required />
            <datalist id="room-list">
              {roomNames.map(r => <option key={r} value={r} />)}
            </datalist>
          </div>

          <div className="form-field">
            <label>Check-in *</label>
            <input type="date" value={form.checkin} onChange={(e) => update('checkin', e.target.value)} required />
          </div>

          <div className="form-field">
            <label>Check-out *</label>
            <input type="date" value={form.checkout} onChange={(e) => update('checkout', e.target.value)} required />
          </div>

          <div className="form-field">
            <label>+1 of (guest they're accompanying)</label>
            <select value={form.plus_one_of} onChange={(e) => update('plus_one_of', e.target.value)}>
              <option value="">None (independent booking)</option>
              {mainGuests.map(b => (
                <option key={b.id} value={b.id}>{b.guest} ({b.room})</option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => update('status', e.target.value)}>
              <option value="confirmed">Confirmed</option>
              <option value="blocked">Blocked</option>
              <option value="tentative">Tentative</option>
            </select>
          </div>

          <div className="form-field full-width">
            <label>Notes</label>
            <textarea value={form.notes} onChange={(e) => update('notes', e.target.value)} rows={2} placeholder="e.g. Arriving late, needs key code" />
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">{isEdit ? 'Save Changes' : 'Add Booking'}</button>
        </div>
      </form>
    </div>
  )
}

export default BookingForm
